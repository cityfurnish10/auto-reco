// Is today unusual, and for which city?
//
// PURE. Takes history already read, so every rule below is a unit test with no
// database.
//
// THE RULE THAT MATTERS: a day is comparable only when every source reported.
// A city that was missing its guard register has an UNDERSTATED at-risk count,
// and ranking that day against days when all four books filed manufactures a
// "better than usual" verdict out of a data outage. This is the same refusal
// lib/stock/coverage.ts makes for the Stock Analyser, applied to a smaller
// question — and the reason the copy says "not comparable", never "no change".

import { isCityOff } from "../../engine/schedule";
import type { City } from "../../sample-data";

/** A city's at-risk trend against its own recent comparable days. */
export type CityTrend = "worse" | "usual" | "better";
/** The day's rate against the rest of the week. Extremes, so the copy is literal. */
export type DayTrend = "worst" | "usual" | "best";

export interface CoverageRow {
  business_date: string;
  city: string;
  movements: number | null;
  reported_p?: boolean | null;
  reported_s?: boolean | null;
  reported_d?: boolean | null;
  reported_o?: boolean | null;
}

/**
 * Did the books that CAN file by run time actually file for this city that day?
 *
 * THE GUARD REGISTER IS DELIBERATELY NOT REQUIRED, and that is not a loosening —
 * it is the only way this function returns true at all.
 *
 * Measured over the whole of guard_uploads (33 rows): ZERO registers have ever
 * been uploaded before their own business date's 16:30 primary run. Median lag
 * from business date to upload is one day. So `reported_p` is false for every
 * city on every primary run, and requiring it here would make every day
 * incomparable and silently disable the entire trend feature — the caller would
 * see nothing but nulls and assume there was no history.
 *
 * Excluding it is also the CORRECT comparison. This asks whether two days can be
 * ranked against each other, not whether either was perfect. The register is
 * uniformly absent at run time, so it understates every day equally and cancels
 * out; what must not vary between the days being compared is the three sources
 * that do answer. A register that lands later is folded in by the D+3 re-check,
 * which rewrites that date's counts for both sides of the comparison alike.
 *
 * Pre-0012 rows carry nulls, which read as false — correctly. Those dates have
 * no coverage record at all, so they cannot serve as a baseline, and treating a
 * missing record as full coverage is exactly the error this guards.
 */
export function fullyCovered(r: CoverageRow): boolean {
  return r.reported_s === true && r.reported_d === true && r.reported_o === true;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** Fewer comparable prior days than this and a city gets no verdict at all. */
export const MIN_COMPARABLE_DAYS = 2;

export interface TrendInput {
  businessDate: string;
  /** Tier-1 count per `city\u0000date`, today included. */
  tier1: Map<string, number>;
  /** Dates with a completed run, excluding today. */
  priorDates: string[];
  /** run_city_stats over the window, one row per (date, city). */
  coverage: CoverageRow[];
  /** Cities in today's digest. */
  cities: string[];
  /** Ratio and floor for "worse", shared with the watch list so the two agree. */
  ratio: number;
  minUnits: number;
}

export interface TrendOutput {
  byCity: Map<string, CityTrend | null>;
  dayTrend: DayTrend | null;
  cleanStreak: number;
}

const SEP = "\u0000";
const key = (city: string, date: string) => `${city}${SEP}${date}`;

export function buildTrends(input: TrendInput): TrendOutput {
  const { businessDate, tier1, priorDates, coverage, cities, ratio, minUnits } = input;

  const covered = new Set<string>();
  const movementsOf = new Map<string, number>();
  for (const r of coverage) {
    if (fullyCovered(r)) covered.add(key(r.city, r.business_date));
    movementsOf.set(key(r.city, r.business_date), Number(r.movements ?? 0));
  }

  // A city-day is usable as a baseline if it was fully covered, or if the
  // warehouse was shut — a Thursday in Mumbai is an EXPECTED absence, and
  // treating it as an outage would strip three of five cities every week.
  const usable = (city: string, date: string) =>
    covered.has(key(city, date)) || isCityOff(city as City, date);

  const byCity = new Map<string, CityTrend | null>();
  for (const city of cities) {
    // A city SHUT TODAY gets no verdict at all.
    //
    // Its at-risk count is structurally zero — the floor was closed, so nothing
    // could go missing — and ranking that against days it was open would print
    // "Better" for Mumbai, Pune and Hyderabad every single Thursday. A weekly
    // holiday is not an improvement. An off day is still usable as a BASELINE
    // (a real zero), which is why `usable` allows it below; it is only today's
    // own verdict that has to be withheld.
    if (isCityOff(city as City, businessDate)) {
      byCity.set(city, null);
      continue;
    }
    // Today itself must be comparable, or there is nothing to rank.
    if (!usable(city, businessDate)) {
      byCity.set(city, null);
      continue;
    }
    const priors = priorDates
      .filter((d) => usable(city, d))
      // An off day contributes a real zero, not a gap: the warehouse moved
      // nothing, so nothing could go missing.
      .map((d) => tier1.get(key(city, d)) ?? 0);
    if (priors.length < MIN_COMPARABLE_DAYS) {
      byCity.set(city, null);
      continue;
    }
    const today = tier1.get(key(city, businessDate)) ?? 0;
    const med = median(priors);

    // Same ratio and floor the watch list uses, so two sentences in one email can
    // never disagree about the same city on the same day.
    if (med > 0 && today >= ratio * med && today - med >= minUnits) byCity.set(city, "worse");
    else if (med >= minUnits && today <= med / ratio) byCity.set(city, "better");
    else byCity.set(city, "usual");
  }

  // The headline needs the WHOLE day comparable: one city short a book
  // understates the total, and a headline ranking a day we could not fully see
  // is the error this module exists to refuse.
  const live = cities.filter((c) => !isCityOff(c as City, businessDate));
  const dayUsable = (date: string) =>
    cities.filter((c) => !isCityOff(c as City, date)).every((c) => covered.has(key(c, date)));

  let dayTrend: DayTrend | null = null;
  if (live.length > 0 && dayUsable(businessDate)) {
    const rateOn = (date: string): number | null => {
      let t = 0;
      let m = 0;
      for (const c of cities) {
        t += tier1.get(key(c, date)) ?? 0;
        m += movementsOf.get(key(c, date)) ?? 0;
      }
      return m > 0 ? t / m : null;
    };
    const today = rateOn(businessDate);
    const priors = priorDates.filter(dayUsable).map(rateOn).filter((r): r is number => r !== null);
    if (today !== null && priors.length >= MIN_COMPARABLE_DAYS) {
      // Extremes, not a median comparison, because the copy says "the worst rate
      // this week" — a claim that is either literally true or not made at all.
      if (today >= Math.max(...priors)) dayTrend = "worst";
      else if (today <= Math.min(...priors)) dayTrend = "best";
      else dayTrend = "usual";
    }
  }

  // Consecutive clean days ending today. Only meaningful when today is clean, and
  // only counted over days we could actually see.
  let cleanStreak = 0;
  const totalOn = (date: string) => cities.reduce((n, c) => n + (tier1.get(key(c, date)) ?? 0), 0);
  if (dayUsable(businessDate) && totalOn(businessDate) === 0) {
    cleanStreak = 1;
    for (const d of priorDates) {
      if (!dayUsable(d) || totalOn(d) !== 0) break;
      cleanStreak++;
    }
  }

  return { byCity, dayTrend, cleanStreak };
}
