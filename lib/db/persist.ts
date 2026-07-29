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

export async function createRun(
  db: DB,
  opts: { runDate: string; trigger: "cron" | "manual"; triggeredBy?: string }
): Promise<string> {
  const { data, error } = await db
    .from("reconciliation_runs")
    .insert({
      business_date: opts.runDate,
      status: "running",
      trigger: opts.trigger,
      triggered_by: opts.triggeredBy ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`createRun failed: ${error.message}`);
  return data.id as string;
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
): Promise<{ superseded: number; resolvedLate: number }> {
  let superseded = 0;
  let resolvedLate = 0;
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

    if (supersededIds.length > 0) {
      const { error: delErr } = await db.from("variances").delete().in("id", supersededIds);
      if (delErr) throw new Error(`resolveStaleOpenVariances delete failed: ${delErr.message}`);
      superseded += supersededIds.length;
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
    }
  }

  return { superseded, resolvedLate };
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
      odoo_in: c.count_in.odoo_count,
      odoo_out: c.count_out.odoo_count,
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

export async function finalizeRun(
  db: DB,
  runId: string,
  run: MultiCityRun,
  status: "success" | "partial" | "failed"
): Promise<void> {
  const { error } = await db
    .from("reconciliation_runs")
    .update({
      run_date: run.date || null,
      status,
      total: run.combined.total,
      real_count: run.combined.real_count,
      info_count: run.combined.info_count,
      high_priority: run.combined.high_priority,
      by_variance: run.combined.by_variance,
      completed_at: new Date().toISOString(),
    })
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

let warned0015 = false;
function warnNo0015(): void {
  if (warned0015) return;
  warned0015 = true;
  console.warn(
    "[upsertMovementEvents] migration 0015 not applied — the movement ledger was not written. Clean movements for these dates cannot be recovered later; apply supabase/migrations/0015_movement_events.sql."
  );
}
