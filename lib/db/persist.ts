// Persistence layer for the reconcile pipeline. All writes use the service-role
// admin client (bypasses RLS). Keeps the route thin and the SQL shape in one place.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { City } from "../sample-data";
import type { CityRunResult, ReportedSources, SourceRow } from "../engine/types";
import type { MultiCityRun } from "../engine/run";
import { varianceSource } from "../engine/variance-source";
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
    }))
  );
  if (payload.length === 0) return 0;
  const { error } = await db
    .from("variances")
    .upsert(payload, {
      onConflict: "business_date,city,direction,barcode,variance_name",
    });
  if (error) throw new Error(`upsertVariances failed: ${error.message}`);
  return payload.length;
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
          note: "Entry was made late — this gap had cleared on the next-day re-check. No action needed.",
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
  perCity: CityRunResult[]
): Promise<number> {
  const payload = perCity.map((c) => ({
    run_id: runId,
    business_date: c.date || runDate,
    city: c.city,
    movements: c.summary.movements,
    real_count: c.summary.real_count,
    info_count: c.summary.info_count,
    high_count: c.summary.high_priority,
    pp_box_count: c.summary.pp_box_count,
    consumable_count: c.summary.consumable_count,
  }));
  if (payload.length === 0) return 0;
  const { error } = await db
    .from("run_city_stats")
    .upsert(payload, { onConflict: "business_date,city" });
  if (error) throw new Error(`saveCityStats failed: ${error.message}`);
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
    kind: "digest" | "test" | "scheduled";
    businessDate?: string | null;
    status: "sent" | "skipped" | "failed";
    recipients: string[];
    cc?: string[];
    bcc?: string[];
    notes?: string | null;
    sentBy?: string | null;
    messageId?: string | null;
    error?: string | null;
  }
): Promise<string | null> {
  const { data, error } = await db
    .from("email_logs")
    .insert({
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
    })
    .select("id")
    .single();
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
