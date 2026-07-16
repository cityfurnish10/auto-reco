// GET /api/email/preview — the exact digest email HTML for the latest reconciled
// date, rendered from the SAME builder + template the cron/test sends use
// (buildDigestFromDb + renderDigestHtml). Admin-only. The Email Digest page shows
// this in an iframe so the preview always matches what actually goes out.

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { buildDigestFromDb, renderDigestHtml } from "@/lib/email/digest";
import { digestRecipients } from "@/lib/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function dashboardUrl(): string | undefined {
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (explicit) return `${explicit.replace(/\/$/, "")}/dashboard`;
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel}/dashboard`;
  return undefined;
}

export async function GET() {
  const me = await getCurrentAppUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const db = createAdminClient();

  const { data: run } = await db
    .from("reconciliation_runs")
    .select("business_date")
    .order("business_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const date = run?.business_date as string | undefined;
  if (!date) {
    return NextResponse.json({ empty: true, recipients: digestRecipients() });
  }

  const digest = await buildDigestFromDb(db, date);
  const html = renderDigestHtml(digest, dashboardUrl());
  return NextResponse.json({ empty: false, date, html, recipients: digestRecipients() });
}
