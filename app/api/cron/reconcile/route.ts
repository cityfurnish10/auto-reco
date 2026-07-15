// Reconcile pipeline — the scheduled entry point.
//   auth (CRON_SECRET) → pull 4 sources → store raw → run engine → upsert
//   variances (closures preserved) → log ingestion → finalize run → prune.
//
// Excluded from middleware auth via the `api/cron` matcher exclusion; this route
// enforces its own bearer-token check. Node runtime (uses the mongodb driver).
// Handles GET (Vercel Cron) and POST (manual / external scheduler / curl).

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runAllCities } from "@/lib/engine/run";
import { pullAll } from "@/lib/connectors";
import {
  createRun,
  saveSourceRows,
  upsertVariances,
  saveIngestionLogs,
  finalizeRun,
  markRunFailed,
  prune,
} from "@/lib/db/persist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // Hobby ceiling; raise to 300 on Vercel Pro.

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

// Reconciliation runs one day behind ("D-1") — it's only reliable once a
// business day has fully closed out across all 4 sources (overnight ops
// entries, Odoo end-of-day postings, etc.), so the default target date when
// no `?date=` is given is yesterday, not today.
function defaultRunDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
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
    // 1. Pull all 4 sources (tolerant of individual failures).
    const { rowsByCity, results, presentSources } = await pullAll(runDate);

    // 2. Persist the complete raw feed (pruned after 7 days).
    const sourceRowCount = await saveSourceRows(db, runId, runDate, rowsByCity);

    // 3. Run the (unchanged) reconciliation engine.
    const run = runAllCities(rowsByCity);

    // 4. Upsert variances (dedup key; human closures preserved).
    const varianceCount = await upsertVariances(db, runId, run.perCity);

    // 5. Log ingestion health per source.
    await saveIngestionLogs(db, runId, results);

    // 6. Finalize — partial if any source didn't return.
    const status = presentSources === results.length ? "success" : "partial";
    await finalizeRun(db, runId, run, status);

    // 7. Retention backstop.
    await prune(db);

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
