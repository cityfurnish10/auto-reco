// GET /api/email/archive/[id] — admin-only viewer for one sent email.
// Serves the archived snapshot (the exact subject + HTML delivered) from the
// email-archive bucket; for logs that predate the archive feature it falls
// back to RE-RENDERING the digest for the log's business date from current DB
// state — flagged archived:false so the UI can label it as a reconstruction.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { loadEmailArchive } from "@/lib/email/email-archive";
import { buildDigestFromDb, renderDigestHtml, digestSubject } from "@/lib/email/digest";
import { dashboardUrl } from "@/lib/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const me = await getCurrentAppUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  const db = createAdminClient();
  const { data: log, error } = await db
    .from("email_logs")
    .select("id, kind, business_date, status, notes, created_at")
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!log) return NextResponse.json({ error: "email log not found" }, { status: 404 });
  if (log.status !== "sent") {
    return NextResponse.json({ error: "this email was not sent — nothing to view" }, { status: 404 });
  }

  // Preferred: the byte-identical snapshot taken at send time.
  const archived = await loadEmailArchive(db, id);
  if (archived) {
    return NextResponse.json({
      id,
      archived: true,
      subject: archived.subject,
      html: archived.html,
      businessDate: log.business_date,
      createdAt: log.created_at,
    });
  }

  // Fallback (logs from before the archive existed): re-render from the DB.
  if (!log.business_date) {
    return NextResponse.json({ error: "no archived copy and no business date to re-render from" }, { status: 404 });
  }
  const digest = await buildDigestFromDb(db, log.business_date as string);
  return NextResponse.json({
    id,
    archived: false,
    subject: digestSubject(digest),
    html: renderDigestHtml(digest, dashboardUrl(), (log.notes as string) ?? undefined),
    businessDate: log.business_date,
    createdAt: log.created_at,
  });
}
