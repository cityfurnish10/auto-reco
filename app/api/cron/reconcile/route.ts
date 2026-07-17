// Reconcile pipeline — the scheduled entry point.
//   auth (CRON_SECRET) → pull 4 sources → store raw → run engine → upsert
//   variances (closures preserved) → log ingestion → finalize run → prune.
//
// Excluded from middleware auth via the `api/cron` matcher exclusion; this route
// enforces its own bearer-token check. Node runtime (uses the mongodb driver).
// Handles GET (Vercel Cron) and POST (manual / external scheduler / curl).

import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runAllCities } from "@/lib/engine/run";
import { pullAll } from "@/lib/connectors";
import { processPendingGuardUploads } from "@/lib/connectors/ocr/process";
import {
  createRun,
  saveSourceRows,
  upsertVariances,
  saveCityStats,
  saveIngestionLogs,
  finalizeRun,
  markRunFailed,
  prune,
} from "@/lib/db/persist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // Hobby ceiling; raise to 300 on Vercel Pro.

// Constant-time bearer check — avoids leaking the secret via response-timing.
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Reconciliation runs at 22:00 IST — the close of the business day — so the
// default target date (when no `?date=` is given) is TODAY, the day being
// closed. (22:00 IST is 16:30 UTC, still the same calendar date in UTC.) The
// digest for this run is emailed the next morning at 09:00 IST by the separate
// /api/cron/email-digest job, dated by this run's business date.
function defaultRunDate(): string {
  return new Date().toISOString().slice(0, 10);
}

async function handle(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    return NextResponse.json(
      { error: "Supabase not configured (need URL + SERVICE_ROLE key)." },
      { status: 500 }
    );
  }

  const runDate = req.nextUrl.searchParams.get("date") || defaultRunDate();
  const trigger = req.method === "POST" ? "manual" : "cron";
  const db = createAdminClient();

  const runId = await createRun(db, { runDate, trigger });

  try {
    // 0. OCR any guard registers uploaded for this date that haven't been
    //    processed yet, so the PHYSICAL connector below sees them. This is the
    //    primary OCR pass (no separate OCR cron runs by default; /api/cron/ocr
    //    still exists for manual/earlier processing). Best-effort — a stuck OCR
    //    must never block the reconcile.
    const guardOcr = await processPendingGuardUploads(db, {
      businessDate: runDate,
      limit: 10,
    }).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));

    // 1. Pull all 4 sources (tolerant of individual failures).
    const { rowsByCity, results, presentSources, reportedByCity } =
      await pullAll(runDate);

    // 2. Persist the complete raw feed (pruned after 7 days).
    const sourceRowCount = await saveSourceRows(db, runId, runDate, rowsByCity);

    // 3. Run the reconciliation engine. reportedByCity tells the ladder which
    //    sources actually answered per city — an outage or a not-yet-filled
    //    sheet must read as "source down", never as a flood of false HIGHs.
    const run = runAllCities(rowsByCity, new Date(), reportedByCity);

    // 4. Upsert variances (dedup key; human closures preserved).
    const varianceCount = await upsertVariances(db, runId, run.perCity);

    // 4b. Per-city rollup for the leaderboard (movements + REAL count per city).
    await saveCityStats(db, runId, runDate, run.perCity);

    // 5. Log ingestion health per source.
    await saveIngestionLogs(db, runId, results);

    // 6. Finalize — partial if any source didn't return.
    const status = presentSources === results.length ? "success" : "partial";
    await finalizeRun(db, runId, run, status);

    // 7. Retention backstop.
    await prune(db);

    // The management digest is NOT sent here — it goes out the next morning at
    // 09:00 IST via /api/cron/email-digest, dated by this run's business date.

    return NextResponse.json({
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
      sourceRowsStored: sourceRowCount,
      variancesUpserted: varianceCount,
      combined: run.combined,
      guardOcr,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markRunFailed(db, runId, message).catch(() => {});
    return NextResponse.json({ ok: false, runId, error: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
