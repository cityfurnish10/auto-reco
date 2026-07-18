// The reconciliation pipeline, extracted so BOTH the nightly cron
// (app/api/cron/reconcile) and the admin-triggered manual run
// (app/api/reconcile) drive the exact same sequence:
//
//   createRun → OCR pending uploads → pull 4 sources → store raw feed →
//   run engine → upsert variances (human closures preserved) → per-city stats →
//   ingestion logs → finalize run → prune.
//
// It owns the try/catch and marks the run failed on error, returning a typed
// result rather than throwing. Node runtime only (connectors use mongodb /
// googleapis / Azure).

import type { SupabaseClient } from "@supabase/supabase-js";
import { runAllCities, type MultiCityRun } from "../engine/run";
import { pullAll } from "../connectors";
import { processPendingGuardUploads } from "../connectors/ocr/process";
import {
  createRun,
  saveSourceRows,
  upsertVariances,
  saveCityStats,
  saveIngestionLogs,
  finalizeRun,
  markRunFailed,
  prune,
} from "../db/persist";

export interface ReconcileResult {
  ok: boolean;
  runId: string;
  runDate: string;
  status: "success" | "partial" | "failed";
  sources?: { source: string; ok: boolean; rows: number; message?: string }[];
  sourceRowsStored?: number;
  variancesUpserted?: number;
  combined?: MultiCityRun["combined"];
  guardOcr?: unknown;
  error?: string;
}

export async function runReconcilePipeline(
  db: SupabaseClient,
  opts: { runDate: string; trigger: "cron" | "manual"; triggeredBy?: string | null }
): Promise<ReconcileResult> {
  const { runDate, trigger } = opts;
  const runId = await createRun(db, {
    runDate,
    trigger,
    triggeredBy: opts.triggeredBy ?? undefined,
  });

  try {
    // 0. OCR any guard registers uploaded for this date that haven't been
    //    processed yet, so the PHYSICAL connector below sees them. Best-effort —
    //    a stuck OCR must never block the reconcile.
    const guardOcr = await processPendingGuardUploads(db, {
      businessDate: runDate,
      limit: 10,
    }).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));

    // 1. Pull all 4 sources (tolerant of individual failures).
    const { rowsByCity, results, presentSources, reportedByCity } = await pullAll(runDate);

    // 2. Persist the complete raw feed (pruned after 7 days).
    const sourceRowsStored = await saveSourceRows(db, runId, runDate, rowsByCity);

    // 3. Run the reconciliation engine. reportedByCity tells the ladder which
    //    sources actually answered per city — an outage or a not-yet-filled
    //    sheet must read as "source down", never as a flood of false HIGHs.
    const run = runAllCities(rowsByCity, new Date(), reportedByCity);

    // 4. Upsert variances (dedup key; human closures/approvals preserved).
    const variancesUpserted = await upsertVariances(db, runId, run.perCity);

    // 4b. Per-city rollup for the leaderboard (movements + REAL count per city).
    await saveCityStats(db, runId, runDate, run.perCity);

    // 5. Log ingestion health per source.
    await saveIngestionLogs(db, runId, results);

    // 6. Finalize — partial if any source didn't return.
    const status = presentSources === results.length ? "success" : "partial";
    await finalizeRun(db, runId, run, status);

    // 7. Retention backstop.
    await prune(db);

    return {
      ok: true,
      runId,
      runDate: run.date || runDate,
      status,
      sources: results.map((r) => ({
        source: r.source,
        ok: r.ok,
        rows: r.rowsPulled,
        message: r.message,
      })),
      sourceRowsStored,
      variancesUpserted,
      combined: run.combined,
      guardOcr,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markRunFailed(db, runId, message).catch(() => {});
    return { ok: false, runId, runDate, status: "failed", error: message };
  }
}
