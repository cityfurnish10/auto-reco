// Admin-only "send now" of the reconciliation digest.
// POST /api/email/test  { date?, to?: string[]|string, cc?: string[], bcc?: string[], notes? }
//   - date : which business day to summarise (default = latest reconciled run)
//   - to   : recipients (default = the requesting admin's own email)
//   - cc/bcc: additional recipients
//   - notes: an admin note rendered into the email body
// Builds the digest from PERSISTED variances (no source re-pull) and mails it.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";
import {
  buildDigestFromDb,
  sendReconciliationDigest,
  isEmailConfigured,
} from "@/lib/email";
import { saveEmailArchive, saveEmailPdf } from "@/lib/email/email-archive";
import { buildRegisterPdf } from "@/lib/email/register-pdf";
import { saveEmailLog } from "@/lib/db/persist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const me = await getCurrentAppUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!isEmailConfigured()) {
    return NextResponse.json(
      { error: "Email not configured — set GMAIL_USER and GMAIL_APP_PASSWORD." },
      { status: 400 }
    );
  }

  let body: {
    date?: string;
    to?: string[] | string;
    cc?: string[];
    bcc?: string[];
    notes?: string;
  } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine */
  }

  const db = createAdminClient();

  // Resolve the business date: explicit, else the most recent reconciled run.
  let date = body.date?.trim();
  if (!date) {
    const { data } = await db
      .from("reconciliation_runs")
      .select("business_date")
      .order("business_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    date = data?.business_date as string | undefined;
  }
  if (!date) {
    return NextResponse.json(
      { error: "No reconciled run found yet — run a reconcile first." },
      { status: 404 }
    );
  }

  const clean = (list?: string[] | string): string[] =>
    (Array.isArray(list) ? list : list ? [list] : [])
      .map((s) => s.trim())
      .filter(Boolean);

  const toList = clean(body.to);
  const to = toList.length ? toList : me.email ? [me.email] : undefined;
  const cc = clean(body.cc);
  const bcc = clean(body.bcc);
  const notes = body.notes?.trim() || undefined;

  const digest = await buildDigestFromDb(db, date);
  // Attach that date's ops-sheet register. Best-effort: a failure here must
  // never stop the email going out.
  const pdf = await buildRegisterPdf(db, date).catch(() => null);
  const result = await sendReconciliationDigest(digest, {
    ...({ to, cc, bcc, notes }),
    attachments: pdf?.bytes
      ? [{ filename: pdf.filename, content: Buffer.from(pdf.bytes), contentType: "application/pdf" }]
      : undefined,
  });

  // Audit the send for the System Health timeline (best-effort), then snapshot
  // the delivered email into the 30-day archive (also best-effort).
  const logId = await saveEmailLog(db, {
    kind: "test",
    businessDate: date,
    status: result.sent ? "sent" : result.error ? "failed" : "skipped",
    recipients: result.recipients ?? [],
    cc: result.cc ?? [],
    bcc: result.bcc ?? [],
    notes: notes ?? null,
    sentBy: me.id,
    messageId: result.messageId ?? null,
    error: result.error ?? result.skipped ?? null,
  }).catch(() => null);
  if (logId && result.sent && result.html) {
    await saveEmailArchive(db, logId, {
      subject: result.subject ?? "",
      html: result.html,
    }).catch(() => {});
    if (pdf?.bytes) await saveEmailPdf(db, logId, pdf.bytes).catch(() => {});
  }

  // Strip the rendered body from the response — it's archived, not API payload.
  const { html: _html, subject: _subject, ...meta } = result;
  if (!result.sent) {
    return NextResponse.json(
      { error: result.error ?? result.skipped ?? "send failed", ...meta },
      { status: 502 }
    );
  }
  return NextResponse.json({ ok: true, date, ...meta });
}
