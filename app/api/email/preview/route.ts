// GET /api/email/preview — the exact digest email for the latest reconciled
// date, rendered from the SAME builder + template the cron/test sends use
// (buildDigestFromDb + digestSubject + renderDigestHtml). Admin-only. The Email
// Digest page shows this in an iframe so the preview always matches what
// actually goes out.
//
// ?notes= is accepted so the compose panel's note appears in the preview. The
// preview previously dropped it and the UI had to admit "note not shown in
// preview" — which meant nobody could check their own note before sending.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { buildDigestFromDb, renderDigestHtml, digestSubject } from "@/lib/email/digest";
import { dashboardUrl, digestRecipients } from "@/lib/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Matches the textarea's practical ceiling; keeps a hostile query string from
// being rendered into the iframe wholesale.
const MAX_NOTES = 2000;

export async function GET(req: NextRequest) {
  const me = await getCurrentAppUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const db = createAdminClient();

  const { data: run } = await db
    .from("reconciliation_runs")
    .select("business_date")
    // Match the cron, /api/email/test and buildDigestFromDb: a `running` or
    // `failed` run must not make the preview show a different day than the
    // digest that actually goes out.
    .in("status", ["success", "partial"])
    .order("business_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const date = run?.business_date as string | undefined;
  if (!date) {
    return NextResponse.json({ empty: true, recipients: digestRecipients() });
  }

  const notes = req.nextUrl.searchParams.get("notes")?.slice(0, MAX_NOTES) || undefined;

  const digest = await buildDigestFromDb(db, date);
  const html = renderDigestHtml(digest, dashboardUrl(), notes);
  return NextResponse.json({
    empty: false,
    date,
    html,
    // The subject is half of what a recipient sees and was never previewable.
    subject: digestSubject(digest),
    recipients: digestRecipients(),
  });
}
