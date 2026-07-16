// Admin-only test send of the reconciliation digest.
// POST /api/email/test  { date?: "YYYY-MM-DD", to?: string }
//   - date: which business day to summarise (default = latest reconciled run)
//   - to  : override recipient (default = the requesting admin's own email)
// Builds the digest from PERSISTED variances (no source re-pull) and mails it.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";
import {
  buildDigestFromDb,
  sendReconciliationDigest,
  isEmailConfigured,
} from "@/lib/email";

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

  let body: { date?: string; to?: string } = {};
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

  const digest = await buildDigestFromDb(db, date);
  const to = body.to?.trim() ? [body.to.trim()] : me.email ? [me.email] : undefined;
  const result = await sendReconciliationDigest(digest, to);

  if (!result.sent) {
    return NextResponse.json(
      { error: result.error ?? result.skipped ?? "send failed", ...result },
      { status: 502 }
    );
  }
  return NextResponse.json({ ok: true, date, ...result });
}
