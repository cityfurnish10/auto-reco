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
import { runReconcilePipeline } from "@/lib/reconcile/pipeline";
import { reconcileTargetDate, recheckTargetDate } from "@/lib/reconcile/cron-dates";
import { noteRecheckSkipped } from "@/lib/db/persist";
import { addDays } from "@/lib/engine/dates";

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

// The run closes the business day that SHUT an hour ago, not today — a day's
// books aren't complete while it is still open (ops sheet filled through the
// evening, DT scans trickling in, ~half of Odoo postings landing next day).
// See lib/reconcile/cron-dates.ts for the full cadence; the digest for this run
// goes out 15 minutes later, at 16:45 IST, via /api/cron/email-digest.

// Leave this much of the 60s ceiling unused before starting the re-check pass.
//
// Measured on live run rows: a single pass is p50 36s, p90 53s, and two passes
// therefore do not reliably fit. Three of nine recent days show only ONE cron
// run, and one row from 2026-07-20 is still stranded at status='running' — the
// signature of a platform kill, which loses the response AND leaves that row
// stranded forever (prune_expired only sweeps 'failed').
//
// This guard does not make the second pass fit. It converts an invisible kill
// into a visible, honest skip.
const RECHECK_BUDGET_MS = 40_000;

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

  const explicitDate = req.nextUrl.searchParams.get("date");
  const runDate = explicitDate || reconcileTargetDate();
  const trigger = req.method === "POST" ? "manual" : "cron";
  // Opt out of the OCR step on a targeted re-run. The pg_cron ageing sweep
  // (migration 0018) re-reconciles D-2 .. D-7 every afternoon, and a register
  // still unprocessed days later has failed repeatedly — 10 uploads x 55s of
  // Azure polling inside a 60s function is a tail risk with no upside. Same
  // reasoning the scheduled second pass below already applies to itself.
  //
  // Ignored without an explicit ?date=: the primary pass MUST do its OCR, and a
  // stray query param should never be able to quietly disable it.
  const skipOcr = !!explicitDate && req.nextUrl.searchParams.get("skipOcr") !== null;
  // THE definition of "this is the untouched scheduled pass". Used for the run's
  // recorded role AND for the re-check gate below, so the two cannot drift — this
  // predicate was spelled out twice, and the file's own comment records that the
  // last pair of duplicated date expressions here disagreed by a day.
  const scheduled = req.method === "GET" && !explicitDate;
  const db = createAdminClient();

  // The whole pipeline lives in lib/reconcile/pipeline.ts (shared with the
  // admin-triggered /api/reconcile route). The digest is NOT sent here — it
  // goes out 15 minutes later via /api/cron/email-digest.
  const startedAt = Date.now();
  const result = await runReconcilePipeline(db, {
    runDate,
    trigger,
    skipOcr,
    role: scheduled ? "primary" : "adhoc",
  });

  // Second-pass re-check: on the scheduled run (GET, no explicit ?date=), also
  // re-reconcile TWO days before the primary target, so entries made even later
  // — chiefly Odoo postings — fold in and stale open rows resolve (see
  // resolveStaleOpenVariances). Skipped for explicit ?date= / POST so a targeted
  // run stays single.
  //
  // WHY -2 AND NOT -1. The follow-up email for date D reports how much of D was
  // closed, and it must send AFTER D has been re-run. D's digest goes out on
  // D+1; the follow-up goes out on D+3. With this at -1, date D was re-run on
  // D+2 and nothing touched it on D+3.
  //
  // A THIRD pass was the obvious alternative and does not fit: a pass is p50
  // 36s against a 60s ceiling, and even two are already unreliable. Moving the
  // one pass costs nothing, and a wider window folds in strictly MORE late
  // postings than -1 did. What is given up is a day of freshness — a date's
  // automatic cleanup now lands on D+3 rather than D+2.
  //
  // OCR is skipped on this pass: a register still pending three days later has
  // failed repeatedly, and 10 uploads x 55s of Azure polling inside a 60s
  // function is a tail risk with no upside. Skipping is fail-safe — the guard
  // source is then simply absent, fullCoverage is false, and the resolved-late
  // branch does not fire at all.
  let recheck: unknown;
  if (scheduled) {
    const elapsed = Date.now() - startedAt;
    if (elapsed > RECHECK_BUDGET_MS) {
      const reason = `budget: ${elapsed}ms elapsed of ${RECHECK_BUDGET_MS}ms`;
      recheck = { ok: false, skipped: "budget", elapsedMs: elapsed };
      // Record it on the primary run (migration 0017). Until now this lived only
      // in the response body, so "this date has only one run" was
      // indistinguishable from "the platform killed us" — and the Stock Analyser
      // has to tell the reader which.
      await noteRecheckSkipped(db, result.runId, reason).catch(() => {});
    } else {
      // recheckTargetDate(), not local arithmetic: the follow-up email looks
      // for a re-run of exactly this date, so the two must be one expression.
      // They were briefly two, and disagreed by a day.
      recheck = await runReconcilePipeline(db, {
        runDate: recheckTargetDate(),
        trigger: "cron",
        skipOcr: true,
        role: "recheck",
      }).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    }
  }

  return NextResponse.json({ ...result, recheck }, { status: result.ok ? 200 : 500 });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
