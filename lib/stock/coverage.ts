// Whether two runs of a date may be compared at all.
//
// PURE. This is the most important file in the Stock Analyser, and it exists
// because of one measured pair of numbers.
//
// 2026-07-26 has a run reading real=101 and another reading real=26. The second
// was status='partial'. A naive diff prints "75 items fixed". Nothing was fixed —
// a source was down. 2026-07-25 swings 237 -> 422 -> 397 across three runs, so
// this is not a rare edge.
//
// THE RULE: a difference between two runs is a fact about STOCK only when the
// later run's evidence base is at least as wide as the earlier one's. Otherwise
// the page shows two independent totals and no delta at all.

import { isCityOff } from "../engine/schedule";
import type { City } from "../sample-data";
import { SOURCE_KEYS, type Coverage, type FoldedPass, type SourceKey } from "./snapshot";

/**
 * How far a later run's movement count may fall below an earlier one's before
 * "cleared" stops meaning "fixed" and starts meaning "unseen".
 *
 * The boolean reported_* mask alone is NOT enough: a source that returns one row
 * reads as REPORTED, which is the entire reason lib/reconcile/sheet-guard.ts
 * exists. Calibrated against live data:
 *   2026-07-25  422 -> 397  = −5.9%  PASSES, and is genuine day-over-day noise
 *   2026-07-26  101 ->  26  = −74%   FAILS, and is a source outage
 */
export const MOVEMENT_TOLERANCE = 0.1;

export type CoverageVerdict =
  /** Both runs saw the same books, and enough of them. */
  | "ok"
  /** The later run saw less. "Cleared" cannot be trusted. */
  | "narrowed"
  /** The earlier run saw less. "Newly raised" cannot be trusted. */
  | "widened"
  /** Both directions failed, or the movement floor collapsed both ways. */
  | "incomparable"
  /** No per-run coverage was recorded — before migration 0017. */
  | "unrecorded"
  /** The warehouse was shut. An expected absence, not an outage. */
  | "rest-day"
  /** One of the two runs did not reconcile this city at all. */
  | "not-run";

export interface CityComparability {
  city: string;
  verdict: CoverageVerdict;
  /** Safe to state how many items cleared. */
  clearedTrustworthy: boolean;
  /** Safe to state how many items were newly raised. */
  newlyRaisedTrustworthy: boolean;
  /** Sources that reported in A but not in B. */
  lostInB: SourceKey[];
  /** Sources that reported in B but not in A. */
  lostInA: SourceKey[];
  movementsA: number | null;
  movementsB: number | null;
  restDay: boolean;
  /** The sentence the UI shows for this city. Never assembled in a component. */
  note: string | null;
}

export interface Comparability {
  /** AND across every in-scope, non-rest-day city. */
  clearedTrustworthy: boolean;
  newlyRaisedTrustworthy: boolean;
  perCity: CityComparability[];
  /** Cities whose figures are suppressed. */
  blockedCities: string[];
  /** The banner sentence. Empty when everything is comparable. */
  headline: string;
}

const SOURCE_LABEL: Record<SourceKey, string> = {
  P: "guard's book",
  S: "ops sheet",
  D: "delivery app",
  O: "Odoo",
};

const cityName = (c: string) => c.charAt(0) + c.slice(1).toLowerCase();

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function lost(from: Coverage, to: Coverage): SourceKey[] {
  return SOURCE_KEYS.filter((s) => from[s] && !to[s]);
}

/** movements_to must not have collapsed relative to movements_from. */
function floorHolds(from: number, to: number): boolean {
  if (from <= 0) return true; // nothing to fall from
  return to >= from * (1 - MOVEMENT_TOLERANCE);
}

export function assessComparability(a: FoldedPass, b: FoldedPass, date: string): Comparability {
  // Every city either run touched. A city one run skipped is a real state and must
  // render as "not run", never as zero — migration 0012 learned the same lesson
  // about a zero count meaning two different things.
  const cityNames = [...new Set([...a.cities.keys(), ...b.cities.keys()])].sort();
  const perCity: CityComparability[] = [];

  for (const city of cityNames) {
    const sa = a.cities.get(city);
    const sb = b.cities.get(city);
    const restDay = isCityOff(city as City, date);

    // Rest days FIRST. A Thursday in Mumbai has no floor sources by design;
    // classifying that as an outage would blank three of five cities every week.
    if (restDay) {
      perCity.push({
        city,
        verdict: "rest-day",
        clearedTrustworthy: true,
        newlyRaisedTrustworthy: true,
        lostInB: [],
        lostInA: [],
        movementsA: sa?.coverage.movements ?? null,
        movementsB: sb?.coverage.movements ?? null,
        restDay: true,
        note: `${cityName(city)} was closed that day, so nothing there could clear itself.`,
      });
      continue;
    }

    if (!sa || !sb) {
      const which = !sa ? "first check" : "re-check";
      perCity.push({
        city,
        verdict: "not-run",
        clearedTrustworthy: false,
        newlyRaisedTrustworthy: false,
        lostInB: [],
        lostInA: [],
        movementsA: sa?.coverage.movements ?? null,
        movementsB: sb?.coverage.movements ?? null,
        restDay: false,
        note: `${cityName(city)} was not checked by the ${which}, so there is nothing to compare.`,
      });
      continue;
    }

    const lostInB = lost(sa.coverage, sb.coverage);
    const lostInA = lost(sb.coverage, sa.coverage);
    const floorB = floorHolds(sa.coverage.movements, sb.coverage.movements);
    const floorA = floorHolds(sb.coverage.movements, sa.coverage.movements);

    const clearedTrustworthy = lostInB.length === 0 && floorB;
    const newlyRaisedTrustworthy = lostInA.length === 0 && floorA;

    let verdict: CoverageVerdict = "ok";
    let note: string | null = null;

    if (!clearedTrustworthy && !newlyRaisedTrustworthy) {
      verdict = "incomparable";
      note = `${cityName(city)} was seen differently by the two checks, so neither direction of change can be read.`;
    } else if (!clearedTrustworthy) {
      verdict = "narrowed";
      note = lostInB.length
        ? `The re-check could not read the ${list(lostInB.map((s) => SOURCE_LABEL[s]))} for ${cityName(city)}.`
        : `The re-check saw ${sb.coverage.movements} movements in ${cityName(city)} against ${sa.coverage.movements} in the first check — a source answered, but not in full.`;
    } else if (!newlyRaisedTrustworthy) {
      verdict = "widened";
      note = lostInA.length
        ? `The first check could not read the ${list(lostInA.map((s) => SOURCE_LABEL[s]))} for ${cityName(city)}, so it was working from less.`
        : `The first check saw ${sa.coverage.movements} movements in ${cityName(city)} against ${sb.coverage.movements} in the re-check.`;
    } else if (sb.coverage.sheetTruncated || sa.coverage.sheetTruncated) {
      // Both directions pass, but say so — the guard already demoted the sheet, and
      // the reader should know the day is understated even though the delta stands.
      note = `${cityName(city)}'s ops sheet came back short on one check and was set aside, so that day's totals understate it.`;
    }

    perCity.push({
      city,
      verdict,
      clearedTrustworthy,
      newlyRaisedTrustworthy,
      lostInB,
      lostInA,
      movementsA: sa.coverage.movements,
      movementsB: sb.coverage.movements,
      restDay: false,
      note,
    });
  }

  // NO cities at all is treated as FAILED coverage, because `every()` over an
  // empty list is vacuously TRUE — and that would put a confident green delta on
  // a date about which nothing whatsoever is known.
  //
  // A date on which every in-scope warehouse was SHUT is a different thing and
  // stays trustworthy: the counts are all zero, and zero equals zero. Hence the
  // guard is on perCity, while the test itself runs over the non-rest-day subset.
  const known = perCity.length > 0;
  const scoreable = perCity.filter((c) => !c.restDay);
  const clearedTrustworthy = known && scoreable.every((c) => c.clearedTrustworthy);
  const newlyRaisedTrustworthy = known && scoreable.every((c) => c.newlyRaisedTrustworthy);

  const blockedCities = scoreable.filter((c) => !c.clearedTrustworthy).map((c) => c.city);

  let headline = "";
  if (!clearedTrustworthy) {
    const reasons = scoreable.filter((c) => !c.clearedTrustworthy && c.note).map((c) => c.note!);
    headline = `${reasons[0]} Items that look cleared may only be unseen.`;
  } else if (!newlyRaisedTrustworthy) {
    const reasons = scoreable.filter((c) => !c.newlyRaisedTrustworthy && c.note).map((c) => c.note!);
    headline = `${reasons[0]} Items that look new were probably always there.`;
  }

  return { clearedTrustworthy, newlyRaisedTrustworthy, perCity, blockedCities, headline };
}

/**
 * Coverage was never recorded for these runs (both predate migration 0017).
 *
 * A separate constructor rather than a flag, so a caller cannot forget to set the
 * trustworthy flags to false.
 */
export function unrecordedComparability(cities: string[]): Comparability {
  return {
    clearedTrustworthy: false,
    newlyRaisedTrustworthy: false,
    perCity: cities.sort().map((city) => ({
      city,
      verdict: "unrecorded" as const,
      clearedTrustworthy: false,
      newlyRaisedTrustworthy: false,
      lostInB: [],
      lostInA: [],
      movementsA: null,
      movementsB: null,
      restDay: false,
      note: null,
    })),
    blockedCities: cities,
    headline:
      "What each check could see was not recorded for this day, so the two cannot be compared.",
  };
}
