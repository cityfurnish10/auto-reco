// Reads for the Stock Analyser. Service-role (the page is admin-only), so RLS is
// bypassed and the role check in each route is the boundary.
//
// EVERY aggregate read pages. PostgREST silently caps an un-ranged select at 1000
// rows — the failure that once made the KPI cards report "169 REAL" for a run
// holding 555 — and the .order("id") before .range() is not optional either: an
// unordered page boundary can repeat or skip rows.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RunRow } from "./passes";
import type { SnapshotRow } from "./snapshot";
import type { CurrentRow } from "../email/followup/compare";

type DB = SupabaseClient;

/** Postgres/PostgREST "this table does not exist" — migration 0017 not applied. */
export function isMissingTable(e: { code?: string; message?: string } | null): boolean {
  if (!e) return false;
  return (
    e.code === "42P01" ||
    e.code === "PGRST205" ||
    /does not exist|could not find/i.test(e.message ?? "")
  );
}

/** Missing COLUMN — an older migration. Distinct from the above; see persist.ts. */
export function isMissingColumn(e: { code?: string; message?: string } | null): boolean {
  if (!e) return false;
  return (
    e.code === "42703" ||
    e.code === "PGRST204" ||
    /does not exist|could not find/i.test(e.message ?? "")
  );
}

async function pageAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error((error as { message?: string }).message ?? String(error));
    const page = (data ?? []) as T[];
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

export async function readRuns(db: DB, date: string): Promise<RunRow[]> {
  const cols =
    "id, business_date, status, trigger, triggered_by, created_at, completed_at, run_role, ocr_skipped, recheck_skipped_reason";
  const { data, error } = await db
    .from("reconciliation_runs")
    .select(cols)
    .eq("business_date", date)
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) {
    // Pre-0017: the three new columns do not exist. Retry without them rather than
    // failing the page — every run is then role 'unknown', which toPasses handles.
    if (!isMissingColumn(error)) throw new Error(`readRuns: ${error.message}`);
    const retry = await db
      .from("reconciliation_runs")
      .select("id, business_date, status, trigger, triggered_by, created_at, completed_at")
      .eq("business_date", date)
      .order("created_at", { ascending: true })
      .limit(100);
    if (retry.error) throw new Error(`readRuns: ${retry.error.message}`);
    return (retry.data ?? []) as RunRow[];
  }
  return (data ?? []) as RunRow[];
}

/** Snapshot rows for a date. Returns null when migration 0017 is not applied. */
export async function readSnapshots(db: DB, date: string): Promise<SnapshotRow[] | null> {
  const probe = await db
    .from("run_city_snapshots")
    .select("run_id")
    .eq("business_date", date)
    .limit(1);
  if (probe.error) {
    if (isMissingTable(probe.error)) return null;
    throw new Error(`readSnapshots: ${probe.error.message}`);
  }
  return pageAll<SnapshotRow>((from, to) =>
    db
      .from("run_city_snapshots")
      .select("*")
      .eq("business_date", date)
      .order("id", { ascending: true })
      .range(from, to)
  );
}

/**
 * Every variance row for a date, across all runs.
 *
 * Not scoped to a run id on purpose: run_id is re-stamped by every upsert, so
 * scoping would return the newest run's rows under the guise of a historical one.
 * The natural key means a unit appears once regardless.
 */
export async function readVariances(db: DB, date: string): Promise<CurrentRow[]> {
  return pageAll<CurrentRow>((from, to) =>
    db
      .from("variances")
      .select("city, direction, barcode, variance_name, job_type, bucket, note, status")
      .eq("business_date", date)
      .order("id", { ascending: true })
      .range(from, to)
  );
}

/** Ticket/product detail for the drill-down, keyed by unit. */
export interface VarianceDetail {
  city: string;
  direction: string | null;
  barcode: string;
  variance_name: string;
  job_type: string | null;
  bucket: string | null;
  note: string | null;
  status: string;
  ticket_id: string | null;
  so_number: string | null;
  product: string | null;
  customer: string | null;
  closure_reason: string | null;
}

export async function readVarianceDetail(db: DB, date: string): Promise<VarianceDetail[]> {
  return pageAll<VarianceDetail>((from, to) =>
    db
      .from("variances")
      .select(
        "city, direction, barcode, variance_name, job_type, bucket, note, status, ticket_id, so_number, product, customer, closure_reason"
      )
      .eq("business_date", date)
      .order("id", { ascending: true })
      .range(from, to)
  );
}

export interface MovementRow {
  business_date: string;
  city: string;
  direction: string;
  barcode: string;
  is_movement: boolean;
  outcome: string;
  backfilled: boolean;
}

/** The ledger. Returns null when migration 0015 is not applied. */
export async function readMovements(
  db: DB,
  from: string,
  to: string
): Promise<MovementRow[] | null> {
  const probe = await db.from("movement_events").select("business_date").limit(1);
  if (probe.error) {
    if (isMissingTable(probe.error)) return null;
    throw new Error(`readMovements: ${probe.error.message}`);
  }
  // Latest run per date. The ledger upserts and never deletes, so rows a newer
  // run no longer emits (merged or parked OCR artifacts) keep their older
  // run_id and would inflate every per-day picture drawn from this read —
  // measured 2026-08-01: 10 killed artifacts still counted as Delhi movements.
  // Rows whose date has no completed run are kept (fail-open): dropping a whole
  // day because its run rows were pruned would be the larger lie.
  const { data: runRows } = await db
    .from("reconciliation_runs")
    .select("id, business_date, created_at")
    .gte("business_date", from)
    .lte("business_date", to)
    .in("status", ["success", "partial"])
    .order("business_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(400);
  const latestByDate = new Map<string, string>();
  for (const r of runRows ?? []) {
    const d = r.business_date as string;
    if (!latestByDate.has(d)) latestByDate.set(d, r.id as string);
  }

  const all = await pageAll<MovementRow & { run_id?: string | null }>((lo, hi) =>
    db
      .from("movement_events")
      .select("business_date, city, direction, barcode, is_movement, outcome, backfilled, run_id")
      .gte("business_date", from)
      .lte("business_date", to)
      .order("id", { ascending: true })
      .range(lo, hi)
  );
  if (all === null) return null;
  return all.filter((m) => {
    const latest = latestByDate.get(m.business_date);
    return latest === undefined || m.run_id === latest;
  });
}

export interface CityStatRow {
  business_date: string;
  city: string;
  movements: number;
  sheet_in: number | null; sheet_out: number | null;
  odoo_in: number | null; odoo_out: number | null;
  dt_in: number | null; dt_out: number | null;
  phys_in: number | null; phys_out: number | null;
  reported_p: boolean | null; reported_s: boolean | null;
  reported_d: boolean | null; reported_o: boolean | null;
  pp_box_count: number | null;
  consumable_count: number | null;
}

export async function readCityStats(db: DB, from: string, to: string): Promise<CityStatRow[]> {
  const full =
    "business_date, city, movements, sheet_in, sheet_out, odoo_in, odoo_out, dt_in, dt_out, phys_in, phys_out, reported_p, reported_s, reported_d, reported_o, pp_box_count, consumable_count";
  try {
    return await pageAll<CityStatRow>((lo, hi) =>
      db
        .from("run_city_stats")
        .select(full)
        .gte("business_date", from)
        .lte("business_date", to)
        .order("id", { ascending: true })
        .range(lo, hi)
    );
  } catch (e) {
    // Pre-0012 the per-source columns do not exist. The aggregate `movements`
    // still does, and it is the only long-range figure for those dates.
    if (!isMissingColumn({ message: e instanceof Error ? e.message : "" })) throw e;
    const rows = await pageAll<{ business_date: string; city: string; movements: number }>(
      (lo, hi) =>
        db
          .from("run_city_stats")
          .select("business_date, city, movements")
          .gte("business_date", from)
          .lte("business_date", to)
          .order("id", { ascending: true })
          .range(lo, hi)
    );
    return rows.map((r) => ({
      ...r,
      sheet_in: null, sheet_out: null, odoo_in: null, odoo_out: null,
      dt_in: null, dt_out: null, phys_in: null, phys_out: null,
      reported_p: null, reported_s: null, reported_d: null, reported_o: null,
      pp_box_count: null, consumable_count: null,
    }));
  }
}

/** Per-source ingestion health for one run — the pre-0017 coverage fallback. */
export async function readIngestion(
  db: DB,
  runIds: string[]
): Promise<{ run_id: string; source: string; status: string; rows_pulled: number }[]> {
  if (runIds.length === 0) return [];
  const { data, error } = await db
    .from("ingestion_logs")
    .select("run_id, source, status, rows_pulled")
    .in("run_id", runIds);
  if (error) throw new Error(`readIngestion: ${error.message}`);
  return (data ?? []) as { run_id: string; source: string; status: string; rows_pulled: number }[];
}
