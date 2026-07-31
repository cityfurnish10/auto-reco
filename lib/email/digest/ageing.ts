// Errors raised days ago and still not settled.
//
// PURE. It takes rows that have already been read, so every awkward case below
// is a unit test with no database.
//
// THE AGE COMES FROM business_date, NOT first_seen_at. That looks like the
// wrong column and is not: resolveStaleOpenVariances HARD-DELETEs a superseded
// row when the same (direction, barcode) re-fires under a different name
// (lib/db/persist.ts:359), and the replacement is inserted fresh. So a unit that
// keeps re-firing gets a brand-new first_seen_at every time and reads as one day
// old however long it has actually been broken — an error in the flattering
// direction, which is the one kind this codebase refuses. business_date is the
// day the problem happened; nothing rewrites it.
//
// FRESHNESS IS NOT OPTIONAL. "Still open" is only true as of the last time that
// date was reconciled, because resolveStaleOpenVariances — the thing that
// notices an item cleared — runs only when a date is re-run. A date the sweep
// (migration 0018) failed to refresh is EXCLUDED from the counts and named,
// never silently folded in.

import { isStillOpen, unitKeyOfRow, type CurrentRow } from "../followup/compare";
import { labelFor } from "../../ui/variance-labels";

/** How many days old an item must be before it is "not closed in time". */
export const MIN_AGE_DAYS = 2;
/** How far back the list looks. */
export const LOOKBACK_DAYS = 7;
/** Kinds named per city before the rest collapse into a count. */
const MAX_KINDS_INLINE = 2;

export interface AgeingRow extends CurrentRow {
  business_date: string;
}

export interface AgeingCity {
  city: string;
  items: number;
  /** Tier 1 — units we cannot account for. */
  atRisk: number;
  /** Tier 2 — records that disagree, where the stock itself is not in doubt. */
  toFix: number;
  oldestDays: number;
  /** Most common kinds, largest first. */
  kinds: { label: string; count: number }[];
  /** Kinds beyond the named ones. */
  otherKinds: number;
}

export interface AgeingGrid {
  /** Business dates, oldest first — the heatmap's columns. */
  dates: string[];
  /** Per city, one count per date in `dates` order. */
  rows: { city: string; counts: number[]; total: number }[];
  /** Column totals, same order as `dates`. */
  dailyTotals: number[];
  grandTotal: number;
}

export interface AgeingSummary {
  cities: AgeingCity[];
  total: number;
  /**
   * Split, deliberately, and never reported as one number.
   *
   * Measured across 27-28 Jul 2026: 188 units at risk against 535 records to
   * fix. A single "683 still open" headline reads as 683 pieces of missing
   * stock when three quarters of it is a missing register line — the same trap
   * the four-way section refuses by showing a split instead of a pass rate.
   */
  atRisk: number;
  toFix: number;
  /** Of `total`, how many are older than a week. */
  overAWeek: number;
  /** Business dates that could not be re-checked; their rows are NOT counted. */
  staleDates: string[];
  /**
   * The same units, arranged city x date — the heatmap.
   *
   * Dated by the day a unit was FIRST seen unresolved, so a run of hot cells
   * along one row is a city that has been accumulating since a particular day,
   * and a hot column is a bad day nobody has cleared. A per-city total cannot
   * show either.
   */
  grid: AgeingGrid;
}

/** Whole days between two ISO dates. Both are IST business dates, never times. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86400_000);
}

/**
 * Roll prior-day variance rows into the per-city ageing table.
 *
 * @param rows        Prior rows, already scoped to ONE run per business date.
 * @param reportDate  The business date this digest reports.
 * @param freshDates  Dates re-reconciled recently enough to be believed.
 */
export function summariseAgeing(
  rows: AgeingRow[],
  reportDate: string,
  freshDates: ReadonlySet<string>,
  minAgeDays: number = MIN_AGE_DAYS
): AgeingSummary {
  // One entry per UNIT, not per row. A unit can carry several variance rows on
  // one day and re-appear on several days; counting rows would report churn in
  // the paperwork as a growing pile of missing stock.
  //
  // Keyed city|direction|barcode with NO date, deliberately: the same unit still
  // broken on three consecutive days is ONE unresolved problem, and it is dated
  // by the OLDEST day it appeared on — which is how long it has really been open.
  const worst = new Map<string, { city: string; label: string; date: string; tier: number }>();
  const staleSeen = new Set<string>();

  for (const r of rows) {
    if (!isStillOpen(r.status)) continue;

    // bucket = REAL, the SAME predicate /api/stats/summary uses for the
    // dashboard's "Still open" tile. Three different populations were being
    // called "pending" — 649 open units on 27 Jul, 336 of them tier 1 or 2, and
    // 122 in the REAL bucket — and the email had picked a fourth reading of its
    // own. A number in the inbox that disagrees with the screen is worse than
    // no number, so this now matches the screen by construction.
    if (r.bucket !== "REAL") continue;

    const age = daysBetween(r.business_date, reportDate);
    if (age < 0) continue;

    // Staleness is RECORDED, not excluded. Dropping un-rechecked days left a
    // seven-day grid with one column in it; the pg_cron sweep now re-runs the
    // whole window every afternoon, so a stale day is the exception and worth
    // naming rather than hiding.
    if (!freshDates.has(r.business_date)) staleSeen.add(r.business_date);

    const label = labelFor(r.variance_name, {
      direction: (r.direction as "IN" | "OUT" | "CROSS" | null) ?? null,
      jobType: r.job_type,
      bucket: (r.bucket as "REAL" | "INFO" | null) ?? null,
      note: r.note,
    });
    // Tier 3 is the engine having stopped asking for action. Listing those as
    // overdue would fill the section with work nobody is expected to do.
    if (label.tier >= 3) continue;

    const key = unitKeyOfRow(r);
    const prev = worst.get(key);
    // Oldest date wins, then WORST tier — a unit carrying both a stock-at-risk
    // row and a records-to-fix row is stock at risk, the same precedence
    // classifyRows applies. Otherwise the split below would depend on which row
    // happened to be read first.
    if (!prev || r.business_date < prev.date || (r.business_date === prev.date && label.tier < prev.tier)) {
      worst.set(key, {
        city: r.city,
        label: label.display,
        date: prev && r.business_date > prev.date ? prev.date : r.business_date,
        tier: prev ? Math.min(prev.tier, label.tier) : label.tier,
      });
    }
  }

  const byCity = new Map<
    string,
    { count: number; atRisk: number; toFix: number; oldest: number; kinds: Map<string, number> }
  >();
  let overAWeek = 0;
  let atRisk = 0;
  let toFix = 0;

  for (const u of worst.values()) {
    const age = daysBetween(u.date, reportDate);
    if (age > 7) overAWeek++;
    const c =
      byCity.get(u.city) ??
      { count: 0, atRisk: 0, toFix: 0, oldest: 0, kinds: new Map<string, number>() };
    c.count++;
    if (u.tier === 1) {
      c.atRisk++;
      atRisk++;
    } else {
      c.toFix++;
      toFix++;
    }
    if (age > c.oldest) c.oldest = age;
    c.kinds.set(u.label, (c.kinds.get(u.label) ?? 0) + 1);
    byCity.set(u.city, c);
  }

  const cities: AgeingCity[] = [...byCity.entries()]
    .map(([city, c]) => {
      const ranked = [...c.kinds.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([label, count]) => ({ label, count }));
      return {
        city,
        items: c.count,
        atRisk: c.atRisk,
        toFix: c.toFix,
        oldestDays: c.oldest,
        kinds: ranked.slice(0, MAX_KINDS_INLINE),
        otherKinds: Math.max(0, ranked.length - MAX_KINDS_INLINE),
      };
    })
    // AT RISK first, not total. A city with 4 units nobody can find outranks one
    // with 200 missing register lines, and sorting on the total buries it.
    .sort(
      (a, b) =>
        b.atRisk - a.atRisk ||
        b.toFix - a.toFix ||
        b.oldestDays - a.oldestDays ||
        a.city.localeCompare(b.city)
    );

  // The heatmap. Columns are every date in the window that produced a unit,
  // oldest first; a date the sweep could not refresh contributes nothing and is
  // named separately rather than drawn as an empty column that reads as "clean".
  // EVERY day in the window gets a column, even an empty one. A grid that only
  // shows days with data cannot be read as a trend: the reader cannot tell a
  // clean Tuesday from a Tuesday nobody looked at.
  //
  // The window ENDS AT D-1, not D. The caller reads one run per business date
  // strictly BEFORE the reported day (build.ts uses .lt), so a column for the
  // report date could only ever be zero — and a zero column at the right-hand
  // edge reads as "today is clean" rather than "today is not in this table".
  // Part two already covers the reported day.
  const dates: string[] = [];
  for (let i = LOOKBACK_DAYS; i >= 1; i--) {
    const t = new Date(Date.parse(`${reportDate}T00:00:00Z`) - i * 86400_000);
    dates.push(t.toISOString().slice(0, 10));
  }
  const idx = new Map(dates.map((d, i) => [d, i]));
  const gridByCity = new Map<string, number[]>();
  for (const u of worst.values()) {
    const col = idx.get(u.date);
    if (col === undefined) continue; // older than the window
    const counts = gridByCity.get(u.city) ?? new Array(dates.length).fill(0);
    counts[col]++;
    gridByCity.set(u.city, counts);
  }
  const gridRows = [...gridByCity.entries()]
    .map(([city, counts]) => ({ city, counts, total: counts.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total || a.city.localeCompare(b.city));
  const dailyTotals = dates.map((_, i) => gridRows.reduce((s, r) => s + r.counts[i], 0));

  return {
    cities,
    total: cities.reduce((n, c) => n + c.items, 0),
    atRisk,
    toFix,
    overAWeek,
    staleDates: [...staleSeen].sort(),
    grid: {
      dates,
      rows: gridRows,
      dailyTotals,
      grandTotal: dailyTotals.reduce((a, b) => a + b, 0),
    },
  };
}
