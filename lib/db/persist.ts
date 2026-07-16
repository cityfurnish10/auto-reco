// Persistence layer for the reconcile pipeline. All writes use the service-role
// admin client (bypasses RLS). Keeps the route thin and the SQL shape in one place.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { City } from "../sample-data";
import type { CityRunResult, SourceRow } from "../engine/types";
import type { MultiCityRun } from "../engine/run";
import { varianceSource } from "../engine/variance-source";
import type { ConnectorResult } from "../connectors/types";

type DB = SupabaseClient;

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
    kind: "digest" | "test";
    businessDate?: string | null;
    status: "sent" | "skipped" | "failed";
    recipients: string[];
    messageId?: string | null;
    error?: string | null;
  }
): Promise<void> {
  const { error } = await db.from("email_logs").insert({
    run_id: entry.runId ?? null,
    kind: entry.kind,
    business_date: entry.businessDate ?? null,
    status: entry.status,
    recipients: entry.recipients ?? [],
    message_id: entry.messageId ?? null,
    error: entry.error ?? null,
  });
  if (error) throw new Error(`saveEmailLog failed: ${error.message}`);
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
