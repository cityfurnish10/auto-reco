// Persistence layer for the reconcile pipeline. All writes use the service-role
// admin client (bypasses RLS). Keeps the route thin and the SQL shape in one place.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { City } from "../sample-data";
import type { CityRunResult, ReportedSources, SourceRow } from "../engine/types";
import type { MultiCityRun } from "../engine/run";
import { varianceSource } from "../engine/variance-source";
import { RESOLVED_LATE_NOTE } from "../engine/resolution";
import { canonicalize } from "../engine/barcode";
import { addDays } from "../engine/dates";
import type { ConnectorResult } from "../connectors/types";
import { RUN_SNAPSHOT_SCHEMA, type RunCitySnapshot } from "../reconcile/run-snapshot";

type DB = SupabaseClient;

// Floor history for the engine's date-misalignment demotions: every canonical
// barcode a FLOOR source (guard / sheet / DT) logged on the days AROUND the run
// date (−3 … +1, excluding the run day itself), per city, drawn from the stored
// source_rows (7-day retention comfortably covers the window). A unit that is
// floor-documented on an adjacent day makes today's single-source-only row a
// date echo, and an Odoo record created today for it a backlog entry — the
// engine downgrades both to INFO instead of raising a REAL loss.
export async function loadRecentFloorBarcodes(
  db: DB,
  runDate: string
): Promise<Partial<Record<City, Set<string>>>> {
  const dates = [-3, -2, -1, 1].map((d) => addDays(runDate, d));
  const out: Partial<Record<City, Set<string>>> = {};
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from("source_rows")
      .select("city, barcode")
      .in("source", ["PHYSICAL", "SHEET", "DT"])
      .in("business_date", dates)
      // Deterministic order — unordered .range() pages can repeat/skip rows.
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`loadRecentFloorBarcodes failed: ${error.message}`);
    for (const r of data ?? []) {
      const city = r.city as City;
      (out[city] ??= new Set()).add(canonicalize(String(r.barcode ?? "")));
    }
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return out;
}

/**
 * Which PASS this run is (migration 0017).
 *
 * Orthogonal to `trigger`, which records WHO started it. An admin's targeted
 * re-run is trigger='manual', role='adhoc'; the scheduled re-check is
 * trigger='cron', role='recheck'. Folding them into one column loses one of the
 * two facts permanently.
 */
export type RunRole = "primary" | "recheck" | "adhoc";

export async function createRun(
  db: DB,
  opts: {
    runDate: string;
    trigger: "cron" | "manual";
    triggeredBy?: string;
    /**
     * REQUIRED, not optional, and that is the point: `tsc --noEmit` fails at
     * every call site until its author decides which pass this is. Nothing can
     * be inferred after the fact — the re-check pass writes trigger:'cron',
     * byte-identical to the primary pass.
     */
    role: RunRole;
    /** Step 0 was skipped. True on every re-check pass. */
    skipOcr?: boolean;
  }
): Promise<{ id: string; createdAt: string }> {
  const base = {
    business_date: opts.runDate,
    status: "running",
    trigger: opts.trigger,
    triggered_by: opts.triggeredBy ?? null,
  };
  // created_at is selected because run_city_snapshots denormalises it, which
  // turns "the passes for this date in order" into an index range scan instead
  // of a join on every page load.
  const cols = "id, created_at";

  let { data, error } = await db
    .from("reconciliation_runs")
    .insert({ ...base, run_role: opts.role, ocr_skipped: opts.skipOcr === true })
    .select(cols)
    .single();

  if (error) {
    // THE highest-stakes degradation in this file. createRun is called OUTSIDE
    // runReconcilePipeline's try block, and the cron's primary call has no
    // .catch() — a throw here ends the night with no run row at all, and no
    // variances for the day, purely because two new columns had nowhere to go.
    //
    // 42703 = undefined_column; PostgREST reports an unknown column as PGRST204
    // "Could not find the 'x' column ... in the schema cache".
    if (
      error.code === "42703" ||
      error.code === "PGRST204" ||
      /does not exist|could not find/i.test(error.message)
    ) {
      warnNo0017();
      ({ data, error } = await db
        .from("reconciliation_runs")
        .insert(base)
        .select(cols)
        .single());
    }
  }
  if (error) throw new Error(`createRun failed: ${error.message}`);
  return {
    id: data!.id as string,
    createdAt: (data as { created_at?: string }).created_at ?? new Date().toISOString(),
  };
}

/**
 * Record why no re-check pass followed a scheduled primary run.
 *
 * Best-effort and deliberately quiet: this is an explanation, not a result. The
 * fact previously existed only in the cron's HTTP response body and was
 * discarded, so "this date has only one run" was indistinguishable from "the
 * platform killed us".
 */
export async function noteRecheckSkipped(
  db: DB,
  runId: string,
  reason: string
): Promise<void> {
  await db
    .from("reconciliation_runs")
    .update({ recheck_skipped_reason: reason })
    .eq("id", runId);
}

export async function saveSourceRows(
  db: DB,
  runId: string,
  runDate: string,
  rowsByCity: Record<City, SourceRow[]>
): Promise<number> {
  const payload: Record<string, unknown>[] = [];
  for (const [city, rows] of Object.entries(rowsByCity)) {
    for (const r of rows) {
      payload.push({
        run_id: runId,
        business_date: runDate,
        source: r.source,
        city,
        direction: r.direction,
        barcode: r.barcode,
        status: r.status ?? null,
        so_number: r.soNumber ?? null,
        ticket_id: r.ticketId ?? null,
        customer: r.customer ?? null,
        product: r.product ?? null,
        job_type: r.jobType ?? null,
        date: r.date != null ? String(r.date) : null,
        created_on: r.createdOn != null ? String(r.createdOn) : null,
        movement_date: r.movementDate != null ? String(r.movementDate) : null,
        raw: r as unknown,
      });
    }
  }
  if (payload.length === 0) return 0;
  // Chunk to stay well under payload limits on large feeds.
  const CHUNK = 1000;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const { error } = await db.from("source_rows").insert(payload.slice(i, i + CHUNK));
    if (error) throw new Error(`saveSourceRows failed: ${error.message}`);
  }
  return payload.length;
}

// Upsert variances on the natural key. IMPORTANT: the payload intentionally
// OMITS status / closure columns and first_seen_at, so a re-run refreshes the
// engine-derived detail but never reopens or overwrites a human's CLOSE/DISPUTE.
export async function upsertVariances(
  db: DB,
  runId: string,
  perCity: CityRunResult[]
): Promise<number> {
  const now = new Date().toISOString();
  const payload = perCity.flatMap((c) =>
    c.variances.map((v) => ({
      run_id: runId,
      business_date: v.date,
      city: v.city,
      barcode: v.barcode,
      direction: v.direction,
      variance_name: v.variance_name,
      note: v.note,
      variance_source: varianceSource(v.variance_name, v.direction),
      priority: v.priority,
      original_priority: v.original_priority ?? null,
      bucket: v.bucket,
      dampened: v.dampened ?? false,
      responsible: v.responsible,
      ticket_id: v.ticket_id,
      so_number: v.so_number,
      customer: v.customer,
      product: v.product,
      job_type: v.job_type,
      date: v.date,
      last_seen_at: now,
      // Migration 0013. present_* = which sources confirmed THIS unit;
      // reported_* = which sources reported for the city at all. Both are
      // needed: a source that was down must render as "no data", not as a
      // cross blaming it for an absence it never had the chance to fill.
      present_p: v.present.P,
      present_s: v.present.S,
      present_d: v.present.D,
      present_o: v.present.O,
      reported_p: v.reported.P,
      reported_s: v.reported.S,
      reported_d: v.reported.D,
      reported_o: v.reported.O,
    }))
  );
  if (payload.length === 0) return 0;
  const onConflict = "business_date,city,direction,barcode,variance_name";
  const { error } = await db.from("variances").upsert(payload, { onConflict });
  if (error) {
    // Migration 0013 not applied yet: retry WITHOUT those eight columns rather
    // than throwing. This matters more than the same guard on saveCityStats —
    // upsertVariances is on the nightly critical path (lib/reconcile/pipeline.ts),
    // and a throw here is caught by the pipeline's outer handler, marks the run
    // failed, and leaves the whole day with NO variances, purely because eight
    // display booleans had nowhere to go.
    //
    // PostgREST reports an unknown column either as 42703 (undefined_column) or
    // as PGRST204 "Could not find the 'x' column ... in the schema cache", so
    // the message test covers both spellings.
    if (error.code === "42703" || /does not exist|could not find/i.test(error.message)) {
      const legacy = payload.map((p) => {
        const copy: Record<string, unknown> = { ...p };
        for (const k of PRESENCE_KEYS) delete copy[k];
        return copy;
      });
      const retry = await db.from("variances").upsert(legacy, { onConflict });
      if (retry.error) throw new Error(`upsertVariances failed: ${retry.error.message}`);
      warnNo0013();
      return legacy.length;
    }
    throw new Error(`upsertVariances failed: ${error.message}`);
  }
  return payload.length;
}

const PRESENCE_KEYS = [
  "present_p", "present_s", "present_d", "present_o",
  "reported_p", "reported_s", "reported_d", "reported_o",
] as const;

// Once per process, not once per city — five cities a night would be noise.
let warned0013 = false;
function warnNo0013(): void {
  if (warned0013) return;
  warned0013 = true;
  console.warn(
    "[upsertVariances] migration 0013 not applied — per-source presence flags were not stored. Source badges will read 'not recorded' for these dates until it is applied and the dates are re-run."
  );
}

export interface StaleResolution {
  superseded: number;
  resolvedLate: number;
  /** The same figures per city, for the run snapshot (migration 0017). */
  byCity: Partial<Record<City, { superseded: number; resolvedLate: number }>>;
}

// Stale-open resolution — the "next-day re-check" pass. On a RE-RUN of a date,
// upsertVariances refreshes rows that re-fire under the SAME name, but a gap
// that CLEARED (a late entry folded in) leaves its old open row behind, because
// the upsert conflict key includes variance_name. This pass reconciles that.
// For each city where all four sources reported (so a connector outage can't
// masquerade as a resolution):
//   • an old open row whose (direction, barcode) is now emitted under a
//     DIFFERENT name is SUPERSEDED → delete it (the new row already exists,
//     e.g. a REAL "Not Posted in Odoo" replaced by INFO "Posted Next Day");
//   • an old open row whose barcode is now fully clean (no variance at all)
//     resolved LATE → downgrade in place to INFO with an "entry made late"
//     note, re-stamping run_id so it still shows in this run's dashboard/KPIs.
// Human-resolved rows (in_progress / pending_approval / closed) are untouched.
export async function resolveStaleOpenVariances(
  db: DB,
  runId: string,
  runDate: string,
  perCity: CityRunResult[],
  reportedByCity: Partial<Record<City, ReportedSources>>
): Promise<StaleResolution> {
  let superseded = 0;
  let resolvedLate = 0;
  // Kept per city as well as summed (migration 0017). The run snapshot stores
  // this split so the Stock Analyser has a SECOND, independent number to check
  // its key-diff against — and because superseded rows are hard-DELETEd below,
  // the count is the only surviving trace that they existed at all.
  const byCity: Partial<Record<City, { superseded: number; resolvedLate: number }>> = {};
  const now = new Date().toISOString();

  for (const cr of perCity) {
    const rep = reportedByCity[cr.city];
    if (!rep) continue; // city absent from this run — nothing to compare against
    // Full coverage is required only for the ABSENCE-based resolved-late branch
    // (a missing source must read as "source down", not "gap cleared"). The
    // superseded branch is POSITIVE evidence — the barcode WAS re-emitted this
    // run under a new name — so it is safe under partial coverage too (e.g. a
    // REAL row reclassified to an INFO name must not linger as a stale REAL
    // just because the ops sheet didn't report that day).
    const fullCoverage = rep.P && rep.S && rep.D && rep.O;

    const emittedKeys = new Set<string>();
    const emittedBarcodes = new Set<string>();
    for (const v of cr.variances) {
      emittedKeys.add(`${v.direction}::${v.barcode}::${v.variance_name}`);
      emittedBarcodes.add(`${v.direction}::${v.barcode}`);
    }

    // Paginate — PostgREST caps un-ranged selects at 1000 rows and a big city's
    // day can exceed that; a truncated read here would silently skip stale rows.
    let data: { id: string; direction: string; barcode: string; variance_name: string }[] = [];
    for (let from = 0; ; from += 1000) {
      const { data: page, error } = await db
        .from("variances")
        .select("id, direction, barcode, variance_name")
        .eq("business_date", runDate)
        .eq("city", cr.city)
        .eq("status", "open")
        // Deterministic order — a row missed across an unordered page boundary
        // here is a stale open variance that never gets resolved.
        .order("id", { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error(`resolveStaleOpenVariances select failed: ${error.message}`);
      data = data.concat(page ?? []);
      if (!page || page.length < 1000) break;
    }

    const supersededIds: string[] = [];
    const resolvedIds: string[] = [];
    for (const row of data ?? []) {
      const key = `${row.direction}::${row.barcode}::${row.variance_name}`;
      if (emittedKeys.has(key)) continue; // still current — upsert refreshed it
      if (emittedBarcodes.has(`${row.direction}::${row.barcode}`)) {
        supersededIds.push(row.id as string);
      } else if (fullCoverage) {
        resolvedIds.push(row.id as string);
      }
    }

    const mine = (byCity[cr.city] ??= { superseded: 0, resolvedLate: 0 });

    if (supersededIds.length > 0) {
      const { error: delErr } = await db.from("variances").delete().in("id", supersededIds);
      if (delErr) throw new Error(`resolveStaleOpenVariances delete failed: ${delErr.message}`);
      superseded += supersededIds.length;
      mine.superseded += supersededIds.length;
    }
    if (resolvedIds.length > 0) {
      const { error: updErr } = await db
        .from("variances")
        .update({
          bucket: "INFO",
          priority: "Info",
          dampened: true,
          run_id: runId,
          last_seen_at: now,
          note: RESOLVED_LATE_NOTE,
        })
        .in("id", resolvedIds);
      if (updErr) throw new Error(`resolveStaleOpenVariances update failed: ${updErr.message}`);
      resolvedLate += resolvedIds.length;
      mine.resolvedLate += resolvedIds.length;
    }
  }

  return { superseded, resolvedLate, byCity };
}

// Per-city rollup for the leaderboard (movements = accuracy denominator,
// real_count = numerator, as-found at reconcile time). Upsert on
// (business_date, city) so a re-run of a date overwrites rather than duplicates.
export async function saveCityStats(
  db: DB,
  runId: string,
  runDate: string,
  perCity: CityRunResult[],
  // Which connectors actually reported per city. Persisted because a zero
  // count cannot distinguish "the source was down" from "nothing moved", and
  // the digest has to say the right one.
  reportedByCity?: Partial<Record<City, ReportedSources>>
): Promise<number> {
  const payload = perCity.map((c) => {
    const rep = reportedByCity?.[c.city];
    return {
      run_id: runId,
      business_date: c.date || runDate,
      city: c.city,
      movements: c.summary.movements,
      real_count: c.summary.real_count,
      info_count: c.summary.info_count,
      high_count: c.summary.high_priority,
      pp_box_count: c.summary.pp_box_count,
      consumable_count: c.summary.consumable_count,
      // Per-source, per-direction movement counts for the digest's Movement
      // Summary table. computeCountLayer already produced these; before 0012
      // they were computed and discarded.
      sheet_in: c.count_in.sheet_total,
      sheet_out: c.count_out.sheet_total,
      // Same-day postings — what the digest reports. The ±1 reconciliation
      // window (odoo_count) would stack three days into one reported column.
      odoo_in: c.count_in.odoo_same_day,
      odoo_out: c.count_out.odoo_same_day,
      dt_in: c.count_in.dt_total,
      dt_out: c.count_out.dt_total,
      phys_in: c.count_in.phys_total,
      phys_out: c.count_out.phys_total,
      reported_p: rep?.P ?? false,
      reported_s: rep?.S ?? false,
      reported_d: rep?.D ?? false,
      reported_o: rep?.O ?? false,
    };
  });
  if (payload.length === 0) return 0;
  const { error } = await db
    .from("run_city_stats")
    .upsert(payload, { onConflict: "business_date,city" });

  if (error) {
    // 42703 = undefined_column: migration 0012 (per-source counts) has not been
    // applied yet. Retry with only the pre-0012 columns rather than throwing —
    // this runs inside the nightly pipeline, so a hard failure here would mark
    // the WHOLE reconcile failed and produce no variances at all for the day,
    // purely because a cosmetic email column is missing.
    if (error.code === "42703" || /does not exist/i.test(error.message)) {
      const legacy = payload.map((p) => ({
        run_id: p.run_id,
        business_date: p.business_date,
        city: p.city,
        movements: p.movements,
        real_count: p.real_count,
        info_count: p.info_count,
        high_count: p.high_count,
        pp_box_count: p.pp_box_count,
        consumable_count: p.consumable_count,
      }));
      const retry = await db
        .from("run_city_stats")
        .upsert(legacy, { onConflict: "business_date,city" });
      if (retry.error) throw new Error(`saveCityStats failed: ${retry.error.message}`);
      console.warn(
        "[saveCityStats] migration 0012 not applied — per-source movement counts were not stored; the digest will omit the movement table."
      );
      return legacy.length;
    }
    throw new Error(`saveCityStats failed: ${error.message}`);
  }
  return payload.length;
}

// ---------------------------------------------------------------------------
// Per-RUN, per-city snapshots (migration 0017).
//
// saveCityStats above upserts on (business_date, city), so the re-check pass
// OVERWRITES the numbers the primary pass produced. That is right for the
// leaderboard — a window sum must not double-count a re-run — and it is exactly
// why "what did the first check find?" has no answer today.
//
// This INSERTs one row per (run_id, city) and never updates. The UNIQUE
// constraint exists to catch a double write, not to permit one.
export async function saveRunCitySnapshots(
  db: DB,
  runId: string,
  runDate: string,
  runStartedAt: string,
  rows: RunCitySnapshot[],
  opts: { backfilled?: boolean } = {}
): Promise<number> {
  if (rows.length === 0) return 0;
  const payload = rows.map((s) => ({
    run_id: runId,
    business_date: s.businessDate || runDate,
    city: s.city,
    run_started_at: runStartedAt,
    schema_version: RUN_SNAPSHOT_SCHEMA,
    movements: s.movements,
    emitted_count: s.emittedCount,
    real_count: s.realCount,
    info_count: s.infoCount,
    high_count: s.highCount,
    tier1_count: s.tier1Count,
    tier2_count: s.tier2Count,
    tier3_count: s.tier3Count,
    flagged_count: s.flaggedCount,
    by_variance: s.byVariance,
    superseded_count: s.supersededCount,
    resolved_late_count: s.resolvedLateCount,
    reported_p: s.reported.P,
    reported_s: s.reported.S,
    reported_d: s.reported.D,
    reported_o: s.reported.O,
    sheet_truncated: s.sheetTruncated,
    sheet_in: s.sheetIn,
    sheet_out: s.sheetOut,
    odoo_in: s.odooIn,
    odoo_out: s.odooOut,
    dt_in: s.dtIn,
    dt_out: s.dtOut,
    phys_in: s.physIn,
    phys_out: s.physOut,
    tier1_keys: s.tier1Keys,
    tier2_keys: s.tier2Keys,
    tier3_keys: s.tier3Keys,
    keys_truncated: s.keysTruncated,
    backfilled: opts.backfilled ?? false,
  }));

  const { error } = await db.from("run_city_snapshots").insert(payload);
  if (error) {
    // A missing TABLE is not a missing COLUMN: PostgREST reports it as PGRST205
    // ("Could not find the table ... in the schema cache") and Postgres as 42P01
    // (undefined_table). The 0013 guard in upsertVariances tests 42703/PGRST204
    // and would NOT catch either of these, so copying it verbatim would let an
    // unapplied 0017 throw on the nightly critical path. Same reasoning as
    // upsertMovementEvents below.
    if (
      error.code === "42P01" ||
      error.code === "PGRST205" ||
      /does not exist|could not find/i.test(error.message)
    ) {
      warnNo0017();
      return 0;
    }
    // A CHECK violation (23514) is deliberately NOT swallowed. It means the
    // builder produced a flagged_count that disagrees with its own tiers, or blew
    // the key budget — a bug that should cost one snapshot, loudly, rather than
    // write history nobody can trust. The pipeline's .catch() downgrades it to a
    // warning.
    throw new Error(`saveRunCitySnapshots failed: ${error.message}`);
  }
  return payload.length;
}

/** 120-day retention for the snapshot key arrays only. Best-effort. */
export async function pruneRunSnapshotKeys(db: DB): Promise<void> {
  await db.rpc("prune_run_snapshot_keys");
}

export async function saveIngestionLogs(
  db: DB,
  runId: string,
  results: ConnectorResult[]
): Promise<void> {
  const payload = results.map((r) => ({
    run_id: runId,
    source: r.source,
    status: r.ok ? "OK" : "FAILED",
    rows_pulled: r.rowsPulled,
    message: r.message ?? null,
    started_at: r.startedAt,
    finished_at: r.finishedAt,
    duration_ms: r.durationMs,
  }));
  if (payload.length === 0) return;
  const { error } = await db.from("ingestion_logs").insert(payload);
  if (error) throw new Error(`saveIngestionLogs failed: ${error.message}`);
}

// Audit one digest email send for the System Health timeline. Best-effort —
// callers wrap in .catch so a logging failure never fails a reconcile.
export async function saveEmailLog(
  db: DB,
  entry: {
    runId?: string | null;
    kind: "digest" | "test" | "scheduled" | "follow_up";
    businessDate?: string | null;
    status: "sent" | "skipped" | "failed";
    recipients: string[];
    cc?: string[];
    bcc?: string[];
    notes?: string | null;
    sentBy?: string | null;
    messageId?: string | null;
    error?: string | null;
    /**
     * The figures the email printed, from SendResult.totals.
     *
     * REQUIRED, not optional, and that is the point: the follow-up's X can only
     * ever come from here, so a fourth send path must fail to compile until its
     * author decides what to store. Pass null deliberately for a send that
     * carried no figures.
     */
    totals: unknown;
  }
): Promise<string | null> {
  const row = () => ({
    run_id: entry.runId ?? null,
    kind: entry.kind,
    business_date: entry.businessDate ?? null,
    status: entry.status,
    recipients: entry.recipients ?? [],
    cc: entry.cc ?? [],
    bcc: entry.bcc ?? [],
    notes: entry.notes ?? null,
    sent_by: entry.sentBy ?? null,
    message_id: entry.messageId ?? null,
    error: entry.error ?? null,
  });

  let { data, error } = await db.from("email_logs")
    .insert({ ...row(), totals: entry.totals ?? null })
    .select("id").single();

  if (error) {
    // Migration 0016 not applied yet: retry without the snapshot column rather
    // than throwing. This runs AFTER the email is already on the wire, so a
    // throw here loses the audit row and the follow-up enqueue for a message
    // the recipient has already read.
    //
    // 42703 = undefined_column; PostgREST reports an unknown column as
    // PGRST204 "Could not find the 'x' column ... in the schema cache".
    if (
      error.code === "42703" ||
      error.code === "PGRST204" ||
      /does not exist|could not find/i.test(error.message)
    ) {
      warnNo0016();
      ({ data, error } = await db.from("email_logs").insert(row()).select("id").single());
    }
  }
  if (error) throw new Error(`saveEmailLog failed: ${error.message}`);
  return data?.id ?? null;
}

/**
 * Cap on stored warnings.
 *
 * Five cities of OCR-orphan merges can run long, and this column is read on a
 * page load. 200 x ~120 B is ~24 KB, which is fine; past that the tail is
 * repetitive and the count is what matters.
 */
const MAX_STORED_WARNINGS = 200;

export async function finalizeRun(
  db: DB,
  runId: string,
  run: MultiCityRun,
  status: "success" | "partial" | "failed",
  /**
   * Pipeline-level warnings (the sheet-truncation guard, chiefly).
   *
   * The `warnings` column has existed since 0001 and only markRunFailed ever
   * wrote it, so every engine and pipeline warning was console.warn only — and on
   * Vercel Hobby those logs are effectively gone within the day. The
   * sheet-truncation warning is the direct, human-readable evidence that a
   * re-check saw less than the primary pass, which is precisely what the Stock
   * Analyser needs to refuse a comparison. It was being thrown away.
   */
  extraWarnings: string[] = []
): Promise<void> {
  const all = [
    ...extraWarnings,
    ...run.perCity.flatMap((c) => c.warnings.map((w) => `${c.city}: ${w}`)),
    ...run.skipped.map((s) => `${s.city} skipped: ${s.error}`),
  ];
  const warnings =
    all.length > MAX_STORED_WARNINGS
      ? [...all.slice(0, MAX_STORED_WARNINGS), `… ${all.length - MAX_STORED_WARNINGS} more suppressed`]
      : all;

  const base = {
    run_date: run.date || null,
    status,
    total: run.combined.total,
    real_count: run.combined.real_count,
    info_count: run.combined.info_count,
    high_priority: run.combined.high_priority,
    by_variance: run.combined.by_variance,
    completed_at: new Date().toISOString(),
  };

  const { error } = await db
    .from("reconciliation_runs")
    .update({ ...base, warnings })
    .eq("id", runId);
  if (error) throw new Error(`finalizeRun failed: ${error.message}`);
}

export async function markRunFailed(db: DB, runId: string, message: string): Promise<void> {
  await db
    .from("reconciliation_runs")
    .update({ status: "failed", warnings: [message] })
    .eq("id", runId);
}

export async function prune(db: DB): Promise<void> {
  const { error } = await db.rpc("prune_expired");
  if (error) throw new Error(`prune failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// The movement ledger (migration 0015).
//
// One row per canonical barcode per direction per business date, CLEAN or not.
// `variances` records only problems, so without this a unit that moved cleanly
// leaves no trace once source_rows is pruned at 7 days — and 2,733 of 4,899
// barcodes measured on live data have a problem on exactly one day, so their
// history is otherwise a single dot.
//
// Upserts on the natural key like variances, NOT a plain insert like
// source_rows, which keeps every re-check pass (4,106 stored rows for a date
// whose run pulled 896).
export async function upsertMovementEvents(
  db: SupabaseClient,
  runId: string,
  perCity: CityRunResult[],
  opts: { backfilled?: boolean } = {}
): Promise<number> {
  const payload = perCity.flatMap((c) =>
    c.movement_events.map((e) => ({
      run_id: runId,
      business_date: e.date,
      city: e.city,
      direction: e.direction,
      barcode: e.barcode,
      present_p: e.present.P,
      present_s: e.present.S,
      present_d: e.present.D,
      present_o: e.present.O,
      reported_p: e.reported.P,
      reported_s: e.reported.S,
      reported_d: e.reported.D,
      reported_o: e.reported.O,
      odoo_same_day: e.odooSameDay,
      odoo_next_day: e.odooNextDay,
      odoo_created_today: e.odooCreatedToday,
      is_movement: e.isMovement,
      job_type: e.jobType,
      so_number: e.soNumber,
      ticket_id: e.ticketId,
      customer: e.customer,
      product: e.product,
      outcome: e.outcome,
      variance_names: e.varianceNames,
      worst_priority: e.worstPriority,
      suppressed_reason: e.suppressedReason,
      backfilled: opts.backfilled ?? false,
      // first_seen_at deliberately omitted so a re-run never resets it — same
      // reason upsertVariances omits it.
      last_seen_at: new Date().toISOString(),
    }))
  );
  if (payload.length === 0) return 0;

  const onConflict = "business_date,city,direction,barcode";
  let written = 0;
  // Chunked like saveSourceRows. ~1,100 events a night, so normally two calls.
  for (let i = 0; i < payload.length; i += 1000) {
    const chunk = payload.slice(i, i + 1000);
    const { error } = await db.from("movement_events").upsert(chunk, { onConflict });
    if (error) {
      // A missing TABLE is not a missing COLUMN: PostgREST reports it as
      // PGRST205 ("Could not find the table ... in the schema cache") and
      // Postgres as 42P01 (undefined_table). The 0013 guard next to this one
      // tests 42703/PGRST204 and would NOT catch either, so copying it verbatim
      // would let an unapplied 0015 throw on the nightly critical path.
      if (
        error.code === "42P01" ||
        error.code === "PGRST205" ||
        /does not exist|could not find/i.test(error.message)
      ) {
        warnNo0015();
        return 0;
      }
      throw new Error(`upsertMovementEvents failed: ${error.message}`);
    }
    written += chunk.length;
  }
  return written;
}

let warned0016 = false;
function warnNo0016(): void {
  if (warned0016) return;
  warned0016 = true;
  console.warn(
    "[saveEmailLog] migration 0016 not applied — the figures each email printed were not stored. Follow-up emails cannot be sent for these dates; apply supabase/migrations/0016_followup_emails.sql."
  );
}

let warned0017 = false;
function warnNo0017(): void {
  if (warned0017) return;
  warned0017 = true;
  console.warn(
    "[reconcile] migration 0017 not applied — per-run, per-city snapshots were not stored and runs are not labelled by pass. The Stock Analyser cannot compare the first check against the re-check for these dates, and it can never be reconstructed; apply supabase/migrations/0017_run_city_snapshots.sql."
  );
}

let warned0015 = false;
function warnNo0015(): void {
  if (warned0015) return;
  warned0015 = true;
  console.warn(
    "[upsertMovementEvents] migration 0015 not applied — the movement ledger was not written. Clean movements for these dates cannot be recovered later; apply supabase/migrations/0015_movement_events.sql."
  );
}

// ---------------------------------------------------------------------------
// The warehouse closure calendar (migration 0019).
// ---------------------------------------------------------------------------

/**
 * Mirror the delivery app's weekly_off + holiday master data into Supabase.
 *
 * Only the reconcile pipeline can reach Mongo; the digest and both dashboards
 * are Supabase-only and all three need this calendar. Refreshed wholesale each
 * run — the source is ~60 rows, so a diff would be more code than it saves, and
 * a full replace cannot leave a deleted holiday behind.
 *
 * DEGRADES ON A MISSING TABLE (42P01 / PGRST205). Migrations are applied by
 * hand here, so a deploy can precede its migration; every reader already falls
 * back to WEEKLY_OFF_DAY, which makes an unapplied 0019 a no-op rather than a
 * failed run.
 */
export async function syncWarehouseCalendar(
  db: DB,
  cal: { weeklyOff: Partial<Record<string, number[]>>; holidays: Partial<Record<string, string[]>> }
): Promise<number> {
  const rows: { city: string; weekday: number | null; holiday_date: string | null }[] = [];
  for (const [city, days] of Object.entries(cal.weeklyOff)) {
    for (const d of days ?? []) rows.push({ city, weekday: d, holiday_date: null });
  }
  for (const [city, dates] of Object.entries(cal.holidays)) {
    for (const d of dates ?? []) rows.push({ city, weekday: null, holiday_date: d });
  }
  // Nothing to write is a legitimate answer (Mongo unreachable, master empty).
  // Wiping the table on that would throw away a good calendar for a bad read.
  if (rows.length === 0) return 0;

  const { error: delErr } = await db
    .from("warehouse_calendar")
    .delete()
    .not("id", "is", null);
  if (delErr) {
    if (delErr.code === "42P01" || delErr.code === "PGRST205") return 0;
    throw new Error(`syncWarehouseCalendar delete failed: ${delErr.message}`);
  }
  const { error } = await db.from("warehouse_calendar").insert(rows);
  if (error) {
    if (error.code === "42P01" || error.code === "PGRST205") return 0;
    throw new Error(`syncWarehouseCalendar insert failed: ${error.message}`);
  }
  return rows.length;
}

/**
 * Read the calendar back. Null when the table is absent or empty, which every
 * caller treats as "use the hardcoded map".
 */
export async function readWarehouseCalendarRows(
  db: DB
): Promise<{ weeklyOff: Record<string, number[]>; holidays: Record<string, string[]> } | null> {
  const { data, error } = await db
    .from("warehouse_calendar")
    .select("city, weekday, holiday_date");
  if (error || !data || data.length === 0) return null;
  const weeklyOff: Record<string, number[]> = {};
  const holidays: Record<string, string[]> = {};
  for (const r of data as { city: string; weekday: number | null; holiday_date: string | null }[]) {
    if (r.weekday !== null && r.weekday !== undefined) {
      (weeklyOff[r.city] ??= []).push(r.weekday);
    } else if (r.holiday_date) {
      (holidays[r.city] ??= []).push(r.holiday_date);
    }
  }
  return { weeklyOff, holidays };
}
