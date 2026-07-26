// Scheduled digest email — sent every morning at 09:00 IST (see vercel.json),
// reporting the business day that last night's 22:00 IST reconcile closed:
// the day before yesterday relative to the send morning (24 Jul is reconciled
// on the night of the 25th and emailed on the morning of the 26th). The one-day
// lag is deliberate — see lib/reconcile/cron-dates.ts.
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
import { storedDigestLists } from "@/lib/email/recipient-store";
import { digestTargetDate } from "@/lib/reconcile/cron-dates";
import { saveEmailArchive, pruneEmailArchive } from "@/lib/email/email-archive";
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

  // Resolve the run to report: explicit ?date=, else the day last night's
  // reconcile closed (digestTargetDate — see lib/reconcile/cron-dates.ts).
  //
  // The lookup is "latest reconciled business date AT OR BEFORE the target",
  // which does two jobs at once: it picks the target when that run exists, and
  // degrades to the most recent EARLIER day when a night was missed — while
  // never reporting a day AHEAD of the target. That last part matters: a manual
  // reconcile of a more recent date (or the nightly job racing the digest) must
  // not hijack the morning mail into reporting a half-written day.
  const dateParam = req.nextUrl.searchParams.get("date");
  let query = db
    .from("reconciliation_runs")
    .select("id, business_date")
    .in("status", ["success", "partial"])
    .order("business_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1);
  query = dateParam
    ? query.eq("business_date", dateParam)
    : query.lte("business_date", digestTargetDate());
  const { data: runs, error: runErr } = await query;
  if (runErr) return NextResponse.json({ error: runErr.message }, { status: 500 });

  const run = runs?.[0];
  if (!run) {
    return NextResponse.json({ ok: false, skipped: "no reconciled run to report yet", scheduled });
  }
  const date = run.business_date as string;

  const digest = await buildDigestFromDb(db, date);
  // Recipients: the admin-curated list saved from the compose panel wins;
  // DIGEST_RECIPIENTS env stays the fallback for a fresh setup.
  const stored = await storedDigestLists(db).catch(() => null);
  const result = await sendReconciliationDigest(digest, stored ?? {});

  // Audit the send for the System Health timeline (best-effort), then snapshot
  // the delivered email into the 30-day archive (also best-effort).
  const logId = await saveEmailLog(db, {
    runId: run.id as string,
    kind: "digest",
    businessDate: date,
    status: result.sent ? "sent" : result.error ? "failed" : "skipped",
    recipients: result.recipients ?? [],
    messageId: result.messageId ?? null,
    error: result.error ?? result.skipped ?? null,
  }).catch(() => null);
  if (logId && result.sent && result.html) {
    await saveEmailArchive(db, logId, {
      subject: result.subject ?? "",
      html: result.html,
    }).catch(() => {});
  }

  // 30-day retention: prune old email logs + their archived documents.
  // Best-effort and capped per run — must never fail the daily send. The
  // scheduled_emails FK is ON DELETE SET NULL, so row deletion is safe.
  let pruned = 0;
  try {
    const cutoff = new Date(Date.now() - 30 * 86400e3).toISOString();
    const { data: old } = await db
      .from("email_logs")
      .select("id")
      .lt("created_at", cutoff)
      .limit(200);
    const ids = (old ?? []).map((r) => r.id as string);
    if (ids.length > 0) {
      await pruneEmailArchive(db, ids); // files first — a failed row-delete retries next run
      const { error: delErr } = await db.from("email_logs").delete().in("id", ids);
      if (!delErr) pruned = ids.length;
    }
  } catch {
    /* retention is a backstop — never fail the response */
  }

  // Strip the rendered body from the response — it's archived, not API payload.
  const { html: _html, subject: _subject, ...meta } = result;
  return NextResponse.json({ ok: true, date, ...meta, scheduled, pruned });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
