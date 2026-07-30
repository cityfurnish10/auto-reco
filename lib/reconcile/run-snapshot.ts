// Freezing what ONE run concluded about each city (migration 0017).
//
// Pure and DB-free on purpose. The builder has to call labelFor() — which lives
// in lib/ui/ because tiers are owner-facing vocabulary — and a persistence layer
// reaching into the UI to compute a stored column is the wrong seam. Keeping the
// decision here also makes the tier logic testable without a Supabase client.
// lib/email/followup/snapshot.ts set exactly this precedent for 0016.
//
// WHY ANY OF THIS EXISTS: see migration 0017's header. In one line — a re-run
// overwrites variances (run_id re-stamped) and run_city_stats (upserted on
// (business_date, city)), so what the first run found is destroyed, and two runs
// of 2026-07-26 reading real=101 and real=26 cannot otherwise be told apart from
// 75 items having been fixed.

import type { City } from "../sample-data";
import type { CityRunResult, ReportedSources, VarianceRowOut } from "../engine/types";
import { flaggedKeyOf } from "../email/followup/snapshot";
import { labelFor, type Tier } from "../ui/variance-labels";

/** Must equal the CHECK constraint in migration 0017. */
export const MAX_RUN_KEYS_PER_CITY = 1200;

export const RUN_SNAPSHOT_SCHEMA = 1;

export interface RunCitySnapshot {
  city: City;
  businessDate: string;
  movements: number;
  /** Variance ROWS emitted. Not tier1+tier2+tier3, which count UNITS. */
  emittedCount: number;
  realCount: number;
  infoCount: number;
  highCount: number;
  tier1Count: number;
  tier2Count: number;
  tier3Count: number;
  /** tier1 + tier2. Stored, never re-derived downstream. */
  flaggedCount: number;
  byVariance: Record<string, number>;
  supersededCount: number;
  resolvedLateCount: number;
  reported: ReportedSources;
  sheetTruncated: boolean;
  sheetIn: number;
  sheetOut: number;
  odooIn: number;
  odooOut: number;
  dtIn: number;
  dtOut: number;
  physIn: number;
  physOut: number;
  tier1Keys: string[];
  tier2Keys: string[];
  tier3Keys: string[];
  keysTruncated: boolean;
}

export interface BuildSnapshotOpts {
  /** Cities whose sheet pull guardTruncatedSheet demoted to reported.S = false. */
  sheetTruncated?: Set<City>;
  /** Per-city split from resolveStaleOpenVariances. */
  stale?: Partial<Record<City, { superseded: number; resolvedLate: number }>>;
}

/** The unit a variance row belongs to — city|direction|barcode. */
function unitOf(v: VarianceRowOut): string {
  return `${v.city}|${v.direction ?? ""}|${v.barcode}`;
}

function tierOfRow(v: VarianceRowOut): Tier {
  return labelFor(v.variance_name, {
    direction: v.direction,
    jobType: v.job_type,
    bucket: v.bucket,
    note: v.note,
  }).tier;
}

/**
 * Group a city's variance rows into one entry per UNIT at its WORST tier.
 *
 * Per unit, not per row, because classifyViews can push a ladder hit AND a
 * duplicate-scan hit for the same unit — counting both would make a later
 * set-difference report a change in rows while calling it a change in stock.
 * Worst tier, so a unit with a tier-1 and a tier-3 row lands in tier 1 and
 * appears in exactly one array: that is what makes `A.keys \ B.keys` a
 * difference in units.
 */
function unitsByTier(rows: VarianceRowOut[]): Map<Tier, string[]> {
  const worst = new Map<string, { tier: Tier; key: string }>();
  for (const v of rows) {
    const unit = unitOf(v);
    const tier = tierOfRow(v);
    const seen = worst.get(unit);
    // Strictly less: the FIRST row at a given tier wins, so the output is a
    // function of row order alone and the arrays are stable across runs.
    if (!seen || tier < seen.tier) worst.set(unit, { tier, key: flaggedKeyOf(v) });
  }
  const out = new Map<Tier, string[]>([
    [1, []],
    [2, []],
    [3, []],
  ]);
  for (const { tier, key } of worst.values()) out.get(tier)!.push(key);
  // Sorted so a stored row is byte-comparable between two runs that found the
  // same units — and so tests do not depend on Map iteration order.
  for (const list of out.values()) list.sort();
  return out;
}

/**
 * Spend the key budget worst-tier-first.
 *
 * A truncated row keeps its tier-1 detail, which is the tier the page cares
 * about. Under the cap this is a no-op; the cap exists because an unbounded
 * barcode list on a Hobby-tier database is a worse failure than one missing
 * item list.
 */
function budget(t1: string[], t2: string[], t3: string[]) {
  const total = t1.length + t2.length + t3.length;
  if (total <= MAX_RUN_KEYS_PER_CITY) {
    return { tier1Keys: t1, tier2Keys: t2, tier3Keys: t3, keysTruncated: false };
  }
  let left = MAX_RUN_KEYS_PER_CITY;
  const take = (list: string[]) => {
    const slice = list.slice(0, Math.max(0, left));
    left -= slice.length;
    return slice;
  };
  return {
    tier1Keys: take(t1),
    tier2Keys: take(t2),
    tier3Keys: take(t3),
    keysTruncated: true,
  };
}

/**
 * One snapshot per city this run actually reconciled.
 *
 * A city absent from `perCity` — skipped, or with no data — produces NO ROW, so
 * the page can render "not run" rather than a zero. Migration 0012 learned the
 * same lesson: a zero count cannot distinguish "the source was down" from
 * "nothing moved".
 */
export function buildRunCitySnapshots(
  perCity: CityRunResult[],
  reportedByCity: Partial<Record<City, ReportedSources>>,
  opts: BuildSnapshotOpts = {}
): RunCitySnapshot[] {
  return perCity.map((c) => {
    const tiers = unitsByTier(c.variances);
    const t1 = tiers.get(1)!;
    const t2 = tiers.get(2)!;
    const t3 = tiers.get(3)!;
    const keys = budget(t1, t2, t3);
    const rep = reportedByCity[c.city] ?? { P: false, S: false, D: false, O: false };
    const stale = opts.stale?.[c.city];

    return {
      city: c.city,
      businessDate: c.date,
      movements: c.summary.movements,
      emittedCount: c.summary.total,
      realCount: c.summary.real_count,
      infoCount: c.summary.info_count,
      highCount: c.summary.high_priority,
      // Counts come from the FULL tier lists, never from the budgeted slices —
      // otherwise truncation would silently understate the day.
      tier1Count: t1.length,
      tier2Count: t2.length,
      tier3Count: t3.length,
      flaggedCount: t1.length + t2.length,
      byVariance: c.summary.by_variance,
      supersededCount: stale?.superseded ?? 0,
      resolvedLateCount: stale?.resolvedLate ?? 0,
      reported: rep,
      sheetTruncated: opts.sheetTruncated?.has(c.city) ?? false,
      sheetIn: c.count_in.sheet_total,
      sheetOut: c.count_out.sheet_total,
      odooIn: c.count_in.odoo_count,
      odooOut: c.count_out.odoo_count,
      dtIn: c.count_in.dt_total,
      dtOut: c.count_out.dt_total,
      physIn: c.count_in.phys_total,
      physOut: c.count_out.phys_total,
      ...keys,
    };
  });
}
