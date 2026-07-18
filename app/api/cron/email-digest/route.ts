// Scheduled digest email — sent every morning at 09:00 IST (see vercel.json),
// decoupled from the reconcile run that happened the previous night at 22:00 IST.
// It emails the digest for the LATEST reconciled business date (so it's always
// "dated right" — the report shows the reconciled day, not the send day).
//
// CRON_SECRET-gated, same as the reconcile job. GET (Vercel Cron) + POST (manual).
// Optional ?date=YYYY-MM-DD to re-send a specific day's digest.

import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  buildDigestFromDb,
  sendReconciliationDigest,
  isEmailConfigured,
} from "@/lib/email";
import { drainScheduledEmails } from "@/lib/email/scheduled";
import { saveEmailLog } from "@/lib/db/persist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handle(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 500 });
  }
  if (!isEmailConfigured()) {
    return NextResponse.json({ ok: false, skipped: "email not configured" });
  }

  const db = createAdminClient();

  // Drain any DUE deferred/scheduled digests first (best-effort — a scheduling
  // failure must not block the daily digest). See lib/email/scheduled.ts.
  let scheduled: Awaited<ReturnType<typeof drainScheduledEmails>> = [];
  try {
    scheduled = await drainScheduledEmails(db, new Date().toISOString());
  } catch (err) {
    console.warn("scheduled email drain failed:", err instanceof Error ? err.message : err);
  }

  // Resolve the run to report: explicit ?date=, else the latest reconciled one.
  const dateParam = req.nextUrl.searchParams.get("date");
  let query = db
    .from("reconciliation_runs")
    .select("id, business_date")
    .in("status", ["success", "partial"])
    .order("created_at", { ascending: false })
    .limit(1);
  if (dateParam) query = query.eq("business_date", dateParam);
  const { data: runs, error: runErr } = await query;
  if (runErr) return NextResponse.json({ error: runErr.message }, { status: 500 });

  const run = runs?.[0];
  if (!run) {
    return NextResponse.json({ ok: false, skipped: "no reconciled run to report yet", scheduled });
  }
  const date = run.business_date as string;

  const digest = await buildDigestFromDb(db, date);
  const result = await sendReconciliationDigest(digest);

  // Audit the send for the System Health timeline (best-effort).
  await saveEmailLog(db, {
    runId: run.id as string,
    kind: "digest",
    businessDate: date,
    status: result.sent ? "sent" : result.error ? "failed" : "skipped",
    recipients: result.recipients ?? [],
    messageId: result.messageId ?? null,
    error: result.error ?? result.skipped ?? null,
  }).catch(() => {});

  return NextResponse.json({ ok: true, date, ...result, scheduled });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
