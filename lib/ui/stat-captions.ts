// The sentences under a KPI number.
//
// A count with no denominator, no baseline and no direction is an orphan: "Open
// 41" cannot tell the reader whether 41 is a normal Tuesday or a crisis. These
// helpers are the one place that decides how a figure is put in context, so the
// admin dashboard, the manager dashboard and the city cards cannot phrase the
// same fact three ways.
//
// PURE. Every function takes an already-fetched aggregate.

import { accuracyOf } from "../stats/accuracy";
import { ageLabel } from "./variance-format";

/**
 * Below this many movements a percentage says more about the sample than the
 * warehouse. Same threshold the leaderboard uses for its "Low sample" badge —
 * imported rather than retyped so the two can never drift apart.
 */
export const MIN_MOVEMENTS = 50;

const n = (x: number) => x.toLocaleString("en-IN");

export interface StatLike {
  real: number;
  movements: number;
  openReal?: number;
  openOver3d?: number;
  oldestOpenAt?: string | null;
}

/**
 * "1 in 73 units moved · 98.6% traced".
 *
 * "1 in N" leads because a percentage answers "how good is this?" while a
 * one-in-N answers "how often does this bite me?" — which is the question
 * someone deciding whether to phone a warehouse is actually asking.
 */
export function rateCaption(agg: StatLike | null | undefined): string {
  if (!agg) return "";
  const { real, movements } = agg;
  // A zero denominator is not a perfect score. It means nothing moved, or the
  // day was never counted, and a percentage there would be an invention.
  if (!movements) return "No movements recorded for this day";
  if (real === 0) return `All ${n(movements)} units that moved can be traced`;
  if (movements < MIN_MOVEMENTS) return `of ${n(movements)} units moved · too few to compare`;
  const acc = accuracyOf(movements, real);
  return `1 in ${n(Math.round(movements / real))} units moved · ${acc}% traced`;
}

/**
 * "6 older than 3 days · oldest 9d" — how stale the queue is.
 *
 * The count alone cannot distinguish 23 items raised this afternoon from 23 that
 * have been sitting a week, and only one of those is a problem.
 */
export function queueCaption(agg: StatLike | null | undefined): string {
  if (!agg) return "";
  const open = agg.openReal ?? 0;
  if (open === 0) return "Nothing left open";
  const stale = agg.openOver3d ?? 0;
  if (stale === 0) return "All raised today";
  return `${n(stale)} older than 3 days · oldest ${ageLabel(agg.oldestOpenAt ?? null)}`;
}

/** "18 of 1,204 units moved · 98.5% traced" — the city-card line. */
export function cityRateLine(agg: StatLike | null | undefined): string {
  if (!agg) return "";
  const { real, movements } = agg;
  if (!movements) return "No movements recorded for this day";
  if (movements < MIN_MOVEMENTS) return `${n(real)} of ${n(movements)} units moved · too few to compare`;
  return `${n(real)} of ${n(movements)} units moved · ${accuracyOf(movements, real)}% traced`;
}

/**
 * "2nd of 3 compared" — where this city sits, cleanest first.
 *
 * The denominator is the number of cities with ENOUGH MOVEMENT to rank, not the
 * number on screen. A warehouse that moved 31 units cannot be meaningfully
 * ranked against one that moved 172, so it is left out — and saying "of 3" while
 * five cards are visible reads as a bug unless the word "compared" is there to
 * explain it. Cities below the floor get no rank line at all; their rate line
 * already says "too few to compare".
 */
export function rankLine(
  city: string,
  all: { city: string; real: number; movements: number }[]
): string | null {
  const scored = all
    .filter((c) => c.movements >= MIN_MOVEMENTS)
    .map((c) => ({ city: c.city, acc: accuracyOf(c.movements, c.real) }))
    .filter((c): c is { city: string; acc: number } => c.acc !== null)
    .sort((a, b) => b.acc - a.acc);
  if (scored.length < 2) return null;
  const i = scored.findIndex((c) => c.city === city);
  if (i < 0) return null;
  return `${i + 1}${ordinal(i + 1)} of ${scored.length} compared`;
}

function ordinal(x: number): string {
  const r = x % 100;
  if (r >= 11 && r <= 13) return "th";
  return ["th", "st", "nd", "rd"][x % 10] ?? "th";
}
