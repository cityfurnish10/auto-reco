// Scheduled digest email — sent at 16:45 IST (see lib/reconcile/cron-dates.ts
// for the UTC mapping), reporting the business day the 16:30 reconcile just
// closed, fifteen minutes earlier:
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
  type DigestData,
} from "@/lib/email";
import { storedDigestLists } from "@/lib/email/recipient-store";
import { digestTargetDate } from "@/lib/reconcile/cron-dates";
import { saveEmailArchive, saveEmailPdf, pruneEmailArchive } from "@/lib/email/email-archive";
import { buildRegisterPdfs, registerAttachments } from "@/lib/email/register-pdf";
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

  // Resolve the run to report: explicit ?date=, else the business day that just
  // closed (digestTargetDate — see lib/reconcile/cron-dates.ts).
  //
  // Pinned with .eq(), not the old "latest run at or before the target" .lte().
  // The digest now fires 15 minutes after the reconcile on the SAME business
  // day, and Vercel Hobby does not guarantee that gap — so a ceiling would
  // quietly report YESTERDAY every time tonight's reconcile was still running
  // or had failed, with nothing in the mail to say so.
  const dateParam = req.nextUrl.searchParams.get("date");
  const targetDate = dateParam ?? digestTargetDate();
  const { data: runs, error: runErr } = await db
    .from("reconciliation_runs")
    .select("id, business_date")
    .in("status", ["success", "partial"])
    .eq("business_date", targetDate)
    .order("created_at", { ascending: false })
    .limit(1);
  if (runErr) return NextResponse.json({ error: runErr.message }, { status: 500 });

  // No completed run for the target day: SEND ANYWAY. Silence is the worst
  // outcome — nobody notices an email that never arrived, whereas a banner
  // saying the reconciliation did not finish gets acted on. buildDigestFromDb
  // sets runIncomplete when it finds no run, and the template renders it.
  const run = runs?.[0] ?? null;
  const date = (run?.business_date as string) ?? targetDate;

  // Same reasoning as the missing-run case above: a query hiccup here must not
  // turn into silence. buildDigestFromDb throws on a PostgREST error, and an
  // uncaught throw returns 500 BEFORE saveEmailLog runs — so the day would end
  // with no email AND no record that one was attempted. Fall back to a minimal
  // digest carrying the incomplete banner, and let the send proceed.
  const built = await buildDigestFromDb(db, date).catch(() => null);
  const buildFailed = built === null;
  const digest: DigestData = built ?? {
    date,
    generatedAt: new Date().toISOString(),
    totals: { movements: 0, tier1: 0, tier2: 0, tier3: 0, open: 0 },
    cities: [],
    actions: [],
    informational: [],
    runIncomplete: true,
  };
  // Recipients: the admin-curated list saved from the compose panel wins;
  // DIGEST_RECIPIENTS env stays the fallback for a fresh setup.
  const stored = await storedDigestLists(db).catch(() => null);
  // Attach that date's ops-sheet register. Best-effort: a failure here must
  // never stop the email going out.
  const registers = await buildRegisterPdfs(db, date).catch(() => null);
  const result = await sendReconciliationDigest(digest, {
    ...(stored ?? {}),
    ...registerAttachments(registers),
  });

  // Audit the send for the System Health timeline (best-effort), then snapshot
  // the delivered email into the 30-day archive (also best-effort).
  const logId = await saveEmailLog(db, {
    runId: (run?.id as string) ?? null,
    kind: "digest",
    businessDate: date,
    status: result.sent ? "sent" : result.error ? "failed" : "skipped",
    recipients: result.recipients ?? [],
    messageId: result.messageId ?? null,
    // Frozen at the wire; the follow-up's X can come from nowhere else.
    totals: result.totals ?? null,
    error:
      result.error ??
      result.skipped ??
      (buildFailed ? "digest build failed — sent incomplete-run banner only" : null),
  }).catch(() => null);
  if (logId && result.sent && result.html) {
    await saveEmailArchive(db, logId, {
      subject: result.subject ?? "",
      html: result.html,
    }).catch(() => {});
    for (const r of registers?.pdfs ?? [])
      await saveEmailPdf(db, logId, r.city, r.bytes).catch(() => {});
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
