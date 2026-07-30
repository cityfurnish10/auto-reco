// Reading a stored run snapshot back (migration 0017).
//
// PURE. Parses a row already fetched, and refuses anything it does not fully
// understand — the same discipline parseTotalsSnapshot() enforces for 0016. A
// half-understood row must never become a number on a page.

import { unitKeyOf } from "../email/followup/snapshot";
import { RUN_SNAPSHOT_SCHEMA } from "../reconcile/run-snapshot";

export type SourceKey = "P" | "S" | "D" | "O";
export const SOURCE_KEYS: SourceKey[] = ["P", "S", "D", "O"];

export interface Coverage {
  P: boolean;
  S: boolean;
  D: boolean;
  O: boolean;
  /** The accuracy denominator as THIS run saw it. Part of the coverage test. */
  movements: number;
  /** reported.S is false because the pull came back short, not because it failed. */
  sheetTruncated: boolean;
  rows: { sheetIn: number; sheetOut: number; odooIn: number; odooOut: number;
          dtIn: number; dtOut: number; physIn: number; physOut: number };
}

export interface PassCitySnapshot {
  runId: string;
  businessDate: string;
  city: string;
  emittedCount: number;
  tier1: number;
  tier2: number;
  tier3: number;
  /** tier1 + tier2, as stored. Never re-derived. */
  flagged: number;
  byVariance: Record<string, number>;
  supersededCount: number;
  resolvedLateCount: number;
  coverage: Coverage;
  /**
   * Full keys (CITY|DIRECTION|BARCODE|VARIANCE_NAME) per tier, or null when the
   * row has none stored.
   *
   * null and [] are DIFFERENT. null means never stored or pruned at 120 days; []
   * means this run genuinely flagged nothing at that tier for this city. A
   * consumer that treats null as empty reports every unit as cleared.
   */
  tier1Keys: string[] | null;
  tier2Keys: string[] | null;
  tier3Keys: string[] | null;
  keysTruncated: boolean;
  keysPruned: boolean;
  backfilled: boolean;
}

/** The raw shape PostgREST returns. */
export interface SnapshotRow {
  run_id: string;
  business_date: string;
  city: string;
  schema_version: number | null;
  movements: number;
  emitted_count: number;
  tier1_count: number;
  tier2_count: number;
  tier3_count: number;
  flagged_count: number;
  by_variance: unknown;
  superseded_count: number;
  resolved_late_count: number;
  reported_p: boolean;
  reported_s: boolean;
  reported_d: boolean;
  reported_o: boolean;
  sheet_truncated: boolean;
  sheet_in: number; sheet_out: number;
  odoo_in: number; odoo_out: number;
  dt_in: number; dt_out: number;
  phys_in: number; phys_out: number;
  tier1_keys: string[] | null;
  tier2_keys: string[] | null;
  tier3_keys: string[] | null;
  keys_truncated: boolean;
  keys_pruned: boolean;
  backfilled: boolean;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const keys = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((k) => typeof k === "string") ? (v as string[]) : null;

/** Returns null on any row whose schema version it does not recognise. */
export function parseSnapshotRow(raw: unknown): PassCitySnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<SnapshotRow>;
  if (typeof r.run_id !== "string" || typeof r.city !== "string") return null;
  if (typeof r.business_date !== "string") return null;
  // A row from a future writer may mean something different by the same column.
  if (r.schema_version != null && r.schema_version !== RUN_SNAPSHOT_SCHEMA) return null;

  return {
    runId: r.run_id,
    businessDate: r.business_date,
    city: r.city,
    emittedCount: num(r.emitted_count),
    tier1: num(r.tier1_count),
    tier2: num(r.tier2_count),
    tier3: num(r.tier3_count),
    flagged: num(r.flagged_count),
    byVariance:
      r.by_variance && typeof r.by_variance === "object"
        ? (r.by_variance as Record<string, number>)
        : {},
    supersededCount: num(r.superseded_count),
    resolvedLateCount: num(r.resolved_late_count),
    coverage: {
      P: r.reported_p === true,
      S: r.reported_s === true,
      D: r.reported_d === true,
      O: r.reported_o === true,
      movements: num(r.movements),
      sheetTruncated: r.sheet_truncated === true,
      rows: {
        sheetIn: num(r.sheet_in), sheetOut: num(r.sheet_out),
        odooIn: num(r.odoo_in), odooOut: num(r.odoo_out),
        dtIn: num(r.dt_in), dtOut: num(r.dt_out),
        physIn: num(r.phys_in), physOut: num(r.phys_out),
      },
    },
    tier1Keys: keys(r.tier1_keys),
    tier2Keys: keys(r.tier2_keys),
    tier3Keys: keys(r.tier3_keys),
    keysTruncated: r.keys_truncated === true,
    keysPruned: r.keys_pruned === true,
    backfilled: r.backfilled === true,
  };
}

/** One run's view of a whole date: its cities, folded. */
export interface FoldedPass {
  runId: string;
  date: string;
  cities: Map<string, PassCitySnapshot>;
  /** Unit keys flagged (tier 1|2), across the cities in scope. */
  flaggedUnits: Set<string>;
  /** Unit keys the run put at tier 3 — "seen, nothing to do". */
  tier3Units: Set<string>;
  /** Full key per unit, for display. Worst tier wins, as stored. */
  keyOfUnit: Map<string, string>;
  flaggedCount: number;
  /** Any city's keys were capped or pruned, so item-level claims are unsafe. */
  keysUnavailable: boolean;
  backfilled: boolean;
}

export function foldPass(runId: string, date: string, rows: PassCitySnapshot[]): FoldedPass {
  const cities = new Map<string, PassCitySnapshot>();
  const flaggedUnits = new Set<string>();
  const tier3Units = new Set<string>();
  const keyOfUnit = new Map<string, string>();
  let flaggedCount = 0;
  let keysUnavailable = false;
  let backfilled = false;

  for (const s of rows) {
    cities.set(s.city, s);
    flaggedCount += s.flagged;
    if (s.backfilled) backfilled = true;
    // null is not empty: a city with no stored keys makes every item-level claim
    // about this pass unsound, so the whole pass is marked rather than that city
    // silently contributing zero cleared units.
    if (s.tier1Keys === null || s.tier2Keys === null || s.tier3Keys === null) {
      keysUnavailable = true;
    }
    if (s.keysTruncated || s.keysPruned) keysUnavailable = true;
    for (const k of [...(s.tier1Keys ?? []), ...(s.tier2Keys ?? [])]) {
      const unit = unitKeyOf(k);
      flaggedUnits.add(unit);
      if (!keyOfUnit.has(unit)) keyOfUnit.set(unit, k);
    }
    for (const k of s.tier3Keys ?? []) {
      const unit = unitKeyOf(k);
      tier3Units.add(unit);
      if (!keyOfUnit.has(unit)) keyOfUnit.set(unit, k);
    }
  }

  return {
    runId,
    date,
    cities,
    flaggedUnits,
    tier3Units,
    keyOfUnit,
    flaggedCount,
    keysUnavailable,
    backfilled,
  };
}
