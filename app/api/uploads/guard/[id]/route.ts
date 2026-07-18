// GET  /api/uploads/guard/[id] — fetch a single upload (RLS-scoped).
// DELETE /api/uploads/guard/[id] — ADMIN-ONLY: permanently remove a guard
//   register — the Storage PDF, the guard_uploads row (which holds the OCR'd
//   parsed_rows / ocr_raw_snapshot), and (best-effort) the Google Drive mirror.
//   OCR runs in the background (lib/connectors/ocr/process.ts) with no review
//   step, so the old PATCH confirm route is gone.

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { deleteGuardPdfFromDrive } from "@/lib/connectors/drive";

export const runtime = "nodejs";

const BUCKET = "guard-registers";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase.from("guard_uploads").select("*").eq("id", id).single();
  if (error || !data) {
    return NextResponse.json({ error: "upload not found or not accessible" }, { status: 404 });
  }
  return NextResponse.json({ data });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const me = await getCurrentAppUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "forbidden — admin only" }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data: upload, error } = await admin
    .from("guard_uploads")
    .select("id, file_path, file_name")
    .eq("id", id)
    .single();
  if (error || !upload) {
    return NextResponse.json({ error: "upload not found" }, { status: 404 });
  }

  // 1. Remove the PDF from Storage (idempotent — a missing object is not an error).
  if (upload.file_path) {
    await admin.storage.from(BUCKET).remove([upload.file_path]);
  }

  // 2. Best-effort: trash the Google Drive mirror copy.
  const drive = await deleteGuardPdfFromDrive(id).catch(() => ({ trashed: false }));

  // 3. Delete the DB row — this is where the OCR output lives
  //    (parsed_rows / ocr_raw_snapshot), so this removes the OCR data too.
  const { error: delErr } = await admin.from("guard_uploads").delete().eq("id", id);
  if (delErr) {
    return NextResponse.json({ error: delErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, file: upload.file_name, driveTrashed: drive.trashed });
}
