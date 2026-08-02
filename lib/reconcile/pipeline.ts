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
import { guardTruncatedSheet } from "./sheet-guard";
import { pullAll } from "../connectors";
import { processPendingGuardUploads } from "../connectors/ocr/process";
import { readWarehouseCalendar } from "../connectors/warehouse-calendar";
import { buildRunCitySnapshots } from "./run-snapshot";
import type { City } from "../sample-data";
import {
  createRun,
  saveSourceRows,
  loadRecentFloorBarcodes,
  upsertVariances,
  upsertMovementEvents,
  resolveStaleOpenVariances,
  saveCityStats,
  saveRunCitySnapshots,
  pruneRunSnapshotKeys,
  saveIngestionLogs,
  syncWarehouseCalendar,
  finalizeRun,
  markRunFailed,
  prune,
  type RunRole,
} from "../db/persist";

export interface ReconcileResult {
  ok: boolean;
  runId: string;
  runDate: string;
  status: "success" | "partial" | "failed";
  sources?: { source: string; ok: boolean; rows: number; message?: string }[];
  sourceRowsStored?: number;
  variancesUpserted?: number;
  movementsLedgered?: number;
  stale?: { superseded: number; resolvedLate: number };
  /** Per-city snapshot rows written for this run (migration 0017). */
  snapshotsWritten?: number;
  combined?: MultiCityRun["combined"];
  guardOcr?: unknown;
  error?: string;
}

export async function runReconcilePipeline(
  db: SupabaseClient,
  opts: {
    runDate: string;
    trigger: "cron" | "manual";
    triggeredBy?: string | null;
    /**
     * Skip step 0 (guard-register OCR). Set by the re-check pass: a register
     * still pending days later has failed repeatedly, and 10 uploads x the 55s
     * Azure timeout inside a 60s function is a tail risk with no upside.
     * Fail-safe — the guard source is then absent, so fullCoverage is false and
     * the resolved-late branch does not fire.
     */
    skipOcr?: boolean;
    /**
     * Which pass this is (migration 0017). REQUIRED — nothing can infer it after
     * the fact, because the re-check writes trigger:'cron' exactly like the
     * primary pass.
     */
    role: RunRole;
  }
): Promise<ReconcileResult> {
  const { runDate, trigger } = opts;
  const { id: runId, createdAt: runStartedAt } = await createRun(db, {
    runDate,
    trigger,
    triggeredBy: opts.triggeredBy ?? undefined,
    role: opts.role,
    skipOcr: opts.skipOcr === true,
  });

  try {
    // 0. OCR any guard registers uploaded for this date that haven't been
    //    processed yet, so the PHYSICAL connector below sees them. Best-effort —
    //    a stuck OCR must never block the reconcile.
    const guardOcr = opts.skipOcr
      ? { skipped: "re-check pass" }
      : await processPendingGuardUploads(db, {
          businessDate: runDate,
          limit: 10,
        }).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));

    // 1. Pull all 4 sources (tolerant of individual failures).
    const { rowsByCity, results, presentSources, reportedByCity: pulledReported } =
      await pullAll(runDate);

    // 1a. Refuse to trust a truncated ops-sheet pull. The Sheets connector keeps
    //     a rolling buffer, and a re-run of an older date can come back short
    //     without looking like an outage — rows are still returned, so the
    //     sheet reads as REPORTED and resolveStaleOpenVariances then rewrites
    //     genuinely-open items to "this gap had cleared". Silent data loss
    //     dressed as a resolution. Best-effort; never fails the run.
    const pipelineWarnings: string[] = [];

    // 1a-0. A source that FAILED must say so where a human looks. Until now the
    //       only trace was an ingestion_logs row, and the run's own warnings —
    //       which the dashboard and System Health read — stayed empty. The ops
    //       sheet failed on every run from 27 Jul 2026 with a malformed
    //       SHEETS_CONFIG and nothing anywhere said the word "sheet"; the run
    //       just went 'partial', as it does for a dozen benign reasons.
    for (const r of results) {
      if (!r.ok) {
        pipelineWarnings.push(`${r.source} source failed: ${r.message ?? "unknown error"}`);
      }
      // A source that answered, but not for everything it was asked for — a tab
      // it could not parse, a city it lost. pullAll has already demoted those
      // cities' reported flags; this is the half a human reads.
      for (const w of r.warnings) pipelineWarnings.push(w);
    }
    // Which cities the guard demoted, as a set rather than a regex over prose —
    // the run snapshot stores it so the Stock Analyser can tell a truncated pull
    // from an outright outage.
    const truncatedCities = new Set<City>();
    const reportedByCity = await guardTruncatedSheet(
      db,
      runDate,
      rowsByCity,
      pulledReported,
      pipelineWarnings,
      truncatedCities
    ).catch(() => pulledReported);
    for (const w of pipelineWarnings) console.warn(`[reconcile] ${w}`);

    // 1b. Mirror the delivery app's closure calendar into Supabase.
    //
    //     Only this pipeline can reach Mongo, and the digest and both
    //     dashboards all need to know when a warehouse is shut — that is what
    //     decides whether an absent register is a schedule or an alarm.
    //     Best-effort by design: every reader falls back to WEEKLY_OFF_DAY, so
    //     a Mongo hiccup costs the holiday list for a day and nothing else.
    const calendarRows = await readWarehouseCalendar()
      .then((cal) => (cal ? syncWarehouseCalendar(db, cal) : 0))
      .catch(() => 0);
    if (calendarRows > 0) console.log(`[reconcile] warehouse calendar: ${calendarRows} rows`);

    // 2. Persist the complete raw feed (pruned after 7 days).
    const sourceRowsStored = await saveSourceRows(db, runId, runDate, rowsByCity);

    // 3. Run the reconciliation engine. reportedByCity tells the ladder which
    //    sources actually answered per city — an outage or a not-yet-filled
    //    sheet must read as "source down", never as a flood of false HIGHs.
    //    recentFloorByCity feeds the date-misalignment demotions (register
    //    pages spanning days, Odoo backlog entries) — best-effort: without it
    //    the engine simply skips those demotions.
    const recentFloorByCity = await loadRecentFloorBarcodes(db, runDate).catch((e) => {
      console.warn("loadRecentFloorBarcodes failed:", e instanceof Error ? e.message : e);
      return {};
    });
    // runDate doubles as the engine's fallback date: a city with no register
    // upload AND a quiet DT (no derivable dates) still reconciles its other
    // sources against the requested day instead of failing.
    const run = runAllCities(rowsByCity, new Date(), reportedByCity, recentFloorByCity, runDate);
    for (const s of run.skipped) {
      console.warn(`reconcile skipped ${s.city}: ${s.error}`);
    }

    // 4. Upsert variances (dedup key; human closures/approvals preserved).
    const variancesUpserted = await upsertVariances(db, runId, run.perCity);

    // 4a. The movement ledger (migration 0015) — every movement this run saw,
    // clean or not. Best-effort in two layers: upsertMovementEvents already
    // swallows an unapplied migration, and this catch covers anything else. It
    // must never take the run down, but it must also run EVERY night — a day
    // missed here can never be reconstructed once source_rows is pruned.
    const movementsLedgered = await upsertMovementEvents(db, runId, run.perCity).catch(
      (e) => {
        console.warn("upsertMovementEvents failed:", e instanceof Error ? e.message : e);
        return 0;
      }
    );

    // 4b. Next-day re-check: on a re-run, resolve/downgrade open rows whose gap
    //     has since cleared (a late entry folded in). Best-effort — a failure
    //     here must not fail an otherwise-good run.
    const stale = await resolveStaleOpenVariances(db, runId, runDate, run.perCity, reportedByCity).catch(
      (e) => {
        console.warn("resolveStaleOpenVariances failed:", e instanceof Error ? e.message : e);
        return { superseded: 0, resolvedLate: 0, byCity: {} };
      }
    );

    // 4c. Per-city rollup for the leaderboard (movements + REAL count per city).
    await saveCityStats(db, runId, runDate, run.perCity, reportedByCity);

    // 4d. Freeze what THIS run concluded, per city, with the coverage it had
    //     (migration 0017).
    //
    //     AFTER 4b, deliberately: resolveStaleOpenVariances reports the
    //     superseded/resolved-late split, and since it hard-DELETEs superseded
    //     rows that count is the only surviving trace they existed.
    //
    //     Built from what the engine EMITTED, so rows the re-check just
    //     downgraded are correctly absent — that is what makes a set difference
    //     between two runs' keys mean "the later run did not re-raise this unit".
    //
    //     Best-effort in two layers, exactly as 4a is: an unapplied migration is
    //     already swallowed inside, and this catch covers the rest. It must never
    //     take the run down, and it must run EVERY night — a run whose snapshot is
    //     missed can never be reconstructed, because upsertVariances has already
    //     re-stamped run_id onto its rows.
    const snapshotsWritten = await saveRunCitySnapshots(
      db,
      runId,
      runDate,
      runStartedAt,
      buildRunCitySnapshots(run.perCity, reportedByCity, {
        sheetTruncated: truncatedCities,
        stale: stale.byCity,
      })
    ).catch((e) => {
      console.warn("saveRunCitySnapshots failed:", e instanceof Error ? e.message : e);
      return 0;
    });

    // 5. Log ingestion health per source.
    await saveIngestionLogs(db, runId, results);

    // 6. Finalize — partial if any source didn't return or any city was skipped.
    //    pipelineWarnings carries the sheet-truncation guard's findings, which
    //    until now were console.warn only and gone within the day on Hobby.
    const status =
      presentSources === results.length && run.skipped.length === 0 ? "success" : "partial";
    await finalizeRun(db, runId, run, status, pipelineWarnings);

    // 7. Retention backstop. WRAPPED, because it runs AFTER finalizeRun: an
    //    un-caught failure here (a lock timeout, a permissions change) fell
    //    through to the outer handler, which calls markRunFailed — overwriting a
    //    fully SUCCESSFUL run's status with 'failed', discarding the warnings just
    //    written, and making the run eligible for the 30-day failed-run delete
    //    that cascades into its variances. A retention sweep must never fail a
    //    completed reconcile.
    await prune(db).catch((e) =>
      console.warn("prune failed:", e instanceof Error ? e.message : e)
    );
    await pruneRunSnapshotKeys(db).catch(() => {});

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
      movementsLedgered,
      stale: { superseded: stale.superseded, resolvedLate: stale.resolvedLate },
      snapshotsWritten,
      combined: run.combined,
      guardOcr,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markRunFailed(db, runId, message).catch(() => {});
    return { ok: false, runId, runDate, status: "failed", error: message };
  }
}
