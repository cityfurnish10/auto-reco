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
  oldestDays: number;
  /** Most common kinds, largest first. */
  kinds: { label: string; count: number }[];
  /** Kinds beyond the named ones. */
  otherKinds: number;
}

export interface AgeingSummary {
  cities: AgeingCity[];
  total: number;
  /** Of `total`, how many are older than a week. */
  overAWeek: number;
  /** Business dates that could not be re-checked; their rows are NOT counted. */
  staleDates: string[];
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
  const worst = new Map<string, { city: string; label: string; date: string }>();
  const staleSeen = new Set<string>();

  for (const r of rows) {
    if (!isStillOpen(r.status)) continue;

    const age = daysBetween(r.business_date, reportDate);
    if (age < minAgeDays) continue;

    // A date nobody re-checked cannot be claimed as still open.
    if (!freshDates.has(r.business_date)) {
      staleSeen.add(r.business_date);
      continue;
    }

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
    // Oldest date wins; on a tie the first label seen is kept, which is stable
    // because the caller reads rows in a deterministic id order.
    if (!prev || r.business_date < prev.date) {
      worst.set(key, { city: r.city, label: label.display, date: r.business_date });
    }
  }

  const byCity = new Map<string, { count: number; oldest: number; kinds: Map<string, number> }>();
  let overAWeek = 0;

  for (const u of worst.values()) {
    const age = daysBetween(u.date, reportDate);
    if (age > 7) overAWeek++;
    const c =
      byCity.get(u.city) ?? { count: 0, oldest: 0, kinds: new Map<string, number>() };
    c.count++;
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
        oldestDays: c.oldest,
        kinds: ranked.slice(0, MAX_KINDS_INLINE),
        otherKinds: Math.max(0, ranked.length - MAX_KINDS_INLINE),
      };
    })
    // Worst first: most items, then oldest, then name so the order is total.
    .sort((a, b) => b.items - a.items || b.oldestDays - a.oldestDays || a.city.localeCompare(b.city));

  return {
    cities,
    total: cities.reduce((n, c) => n + c.items, 0),
    overAWeek,
    staleDates: [...staleSeen].sort(),
  };
}
