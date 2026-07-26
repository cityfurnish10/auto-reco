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
import { reconcileTargetDate } from "@/lib/reconcile/cron-dates";
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

// The nightly run closes YESTERDAY, not today — a day's books aren't complete
// when the day ends (ops sheet filled through the evening, DT scans trickling
// in, ~half of Odoo postings landing the next day), so reconciling at 22:00 on
// the day itself judges half-written data. See lib/reconcile/cron-dates.ts for
// the full cadence; the digest for this run goes out the following morning at
// 09:00 IST via /api/cron/email-digest.

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

  const runDate = req.nextUrl.searchParams.get("date") || reconcileTargetDate();
  const trigger = req.method === "POST" ? "manual" : "cron";
  const db = createAdminClient();

  // The whole pipeline lives in lib/reconcile/pipeline.ts (shared with the
  // admin-triggered /api/reconcile route). The management digest is NOT sent
  // here — it goes out next morning at 09:00 IST via /api/cron/email-digest.
  const result = await runReconcilePipeline(db, { runDate, trigger });

  // Second-pass re-check: on the scheduled nightly run (GET, no explicit
  // ?date=), also re-reconcile the day BEFORE the primary target, so entries
  // made even later — chiefly Odoo postings — fold in and stale REAL rows
  // resolve (see resolveStaleOpenVariances). Best-effort: a failure here never
  // fails the primary response, and the next night (or the manual "Run for
  // date" button) retries. Skipped for explicit ?date= / POST so a targeted
  // run stays single.
  let recheck: unknown;
  if (req.method === "GET" && !req.nextUrl.searchParams.get("date")) {
    recheck = await runReconcilePipeline(db, {
      runDate: addDays(runDate, -1),
      trigger: "cron",
    }).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  }

  return NextResponse.json({ ...result, recheck }, { status: result.ok ? 200 : 500 });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
