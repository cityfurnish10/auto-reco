// The accuracy metric, defined once.
//
// WHY THIS FILE EXISTS: `accuracyOf`, `clampPct` and `daysBefore` were defined
// twice — independently and identically — in app/api/leaderboard/route.ts and
// app/api/analytics/route.ts. Two copies that agree today are two copies that can
// disagree tomorrow, and the dashboard is about to become a third caller. Three
// roundings of the same ratio would let the dashboard and the leaderboard print
// 98.6% and 98.7% for the same day, which is exactly the class of defect the
// copy rewrite exists to remove.
//
// PURE and DB-free: every function takes rows that have already been read.

import { isCityOff } from "../engine/schedule";
import type { City } from "../sample-data";

/** Percent to one decimal, clamped to [0, 100]. */
export function clampPct(x: number): number {
  return Math.round(Math.max(0, Math.min(100, x)) * 10) / 10;
}

/**
 * The share of movements we can trace end to end.
 *
 * NULL, not 0, when there is no denominator. A day with no movements has no
 * accuracy — rendering it as 0% would put a warehouse that was closed at the
 * bottom of a leaderboard. Every caller must render null as an em dash.
 */
export function accuracyOf(movements: number, real: number): number | null {
  return movements > 0 ? clampPct((1 - real / movements) * 100) : null;
}

/** YYYY-MM-DD, n days before the given date. UTC-safe. */
export function daysBefore(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export interface StatRow {
  business_date: string;
  city: string;
  movements: number;
  real_count: number;
  high_count: number;
}

export interface CityTotals {
  movements: number;
  real: number;
  high: number;
}

/**
 * Per-city totals within [from, to] inclusive.
 *
 * String comparison is correct for ISO dates and avoids parsing 150 rows.
 */
export function aggregate(rows: StatRow[], from: string, to: string): Map<string, CityTotals> {
  const map = new Map<string, CityTotals>();
  for (const r of rows) {
    if (!scorable(r, from, to)) continue;
    const a = map.get(r.city) ?? { movements: 0, real: 0, high: 0 };
    a.movements += r.movements;
    a.real += r.real_count;
    a.high += r.high_count;
    map.set(r.city, a);
  }
  return map;
}

/**
 * Does this city-day belong in an accuracy denominator?
 *
 * A CLOSED warehouse is excluded from its own accuracy window.
 *
 * It is not neutral, which is what made this a live bug rather than a rounding
 * quibble. isMovement is `P || S || D || odooSameDay`, so Odoo postings still
 * count movements on a shut day, while run.ts gates the Odoo-only REAL class on
 * `!offDay` — leaving (movements > 0, real = 0). Measured 2026-07-23:
 * MUMBAI 67/0, PUNE 33/0.
 *
 * Averaged over a week that inflates the rate (Mumbai 70.2% shipped against
 * 68.8% true). On the LATEST window it is worse: that window is a single
 * business date, and because Friday's run reconciles Thursday, the board IS a
 * Thursday for about a day every week — where accuracyOf(67, 0) = 100.0% and a
 * variance rate of 0 sorts the closed warehouse FIRST. Mumbai has been taking
 * the trophy for being shut.
 *
 * EXPORTED AND SHARED so the rule has one home. It used to live inline in
 * aggregate() while the analytics page's daily trend summed the same rows with
 * no exclusion at all — same word "accuracy", two denominators, on one screen.
 */
export function scorable(r: StatRow, from: string, to: string): boolean {
  if (r.business_date < from || r.business_date > to) return false;
  return !isCityOff(r.city as City, r.business_date);
}

/** Per-DAY totals across all cities, on the same basis as `aggregate`. */
export function dailyTotals(
  rows: StatRow[],
  from: string,
  to: string
): Map<string, { movements: number; real: number }> {
  const map = new Map<string, { movements: number; real: number }>();
  for (const r of rows) {
    if (!scorable(r, from, to)) continue;
    const a = map.get(r.business_date) ?? { movements: 0, real: 0 };
    a.movements += r.movements;
    a.real += r.real_count;
    map.set(r.business_date, a);
  }
  return map;
}

/**
 * "1 in 49" — the plainest way to say a rate to someone who is not reading a
 * chart.
 *
 * A percentage answers "how good is this?"; a one-in-N answers "how often does
 * this bite me?", which is the question an owner is actually asking. Returns null
 * on no denominator and on a clean day: "1 in 0" and "1 in ∞" are both nonsense,
 * and a clean day has its own sentence.
 */
export function oneInN(movements: number, real: number): number | null {
  if (movements <= 0 || real <= 0) return null;
  return Math.round(movements / real);
}

/**
 * How today's rate compares with a baseline, as a word.
 *
 * Deliberately a verdict and not a delta. "Worse" tells the owner where to walk;
 * "-0.4pp" makes them do arithmetic to reach the same place. The 0.1pp deadband
 * matches the leaderboard's existing trend threshold so two surfaces can never
 * disagree about the same city on the same day.
 */
export type Verdict = "better" | "usual" | "worse";

export function verdictOf(today: number | null, baseline: number | null): Verdict | null {
  if (today === null || baseline === null) return null;
  const delta = today - baseline;
  if (delta > 0.1) return "better";
  if (delta < -0.1) return "worse";
  return "usual";
}
