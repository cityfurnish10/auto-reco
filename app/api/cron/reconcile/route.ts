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

  // The whole pipeline lives in lib/reconcile/pipeline.ts (shared with the
  // admin-triggered /api/reconcile route). The management digest is NOT sent
  // here — it goes out next morning at 09:00 IST via /api/cron/email-digest.
  const result = await runReconcilePipeline(db, { runDate, trigger });
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
