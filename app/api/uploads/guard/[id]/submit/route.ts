// POST /api/uploads/guard/[id]/submit — triggers OCR. Downloads the just-
// uploaded PDF from Storage (admin client — server-to-server; no user-facing
// RLS concern since the cookie-bound lookup below already proved the caller
// owns/can-see this upload's city) and submits it to Azure's async Read API.
// Returns immediately — it does NOT block on Azure; the status route is
// polled by the client until the job completes.

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { submitReadJob, azureVisionConfigured } from "@/lib/connectors/ocr/azure-vision";

export async function POST(
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

  // RLS-scoped read — confirms this user can see this upload before we do
  // anything privileged with it.
  const { data: upload, error: fetchError } = await supabase
    .from("guard_uploads")
    .select("id, file_path, status")
    .eq("id", id)
    .single();
  if (fetchError || !upload) {
    return NextResponse.json({ error: "upload not found or not accessible" }, { status: 404 });
  }
  if (upload.status !== "pending") {
    return NextResponse.json(
      { error: `cannot submit from status '${upload.status}'` },
      { status: 409 }
    );
  }
  if (!azureVisionConfigured()) {
    return NextResponse.json(
      { error: "Azure Vision not configured (set AZURE_VISION_ENDPOINT + AZURE_VISION_API_KEY)." },
      { status: 500 }
    );
  }

  const admin = createAdminClient();
  const { data: fileBlob, error: downloadError } = await admin.storage
    .from("guard-registers")
    .download(upload.file_path);
  if (downloadError || !fileBlob) {
    await admin
      .from("guard_uploads")
      .update({ status: "failed", error: downloadError?.message ?? "download failed" })
      .eq("id", id);
    return NextResponse.json(
      { error: downloadError?.message ?? "failed to download uploaded file" },
      { status: 500 }
    );
  }

  try {
    const bytes = new Uint8Array(await fileBlob.arrayBuffer());
    const { operationUrl } = await submitReadJob(bytes);
    await admin
      .from("guard_uploads")
      .update({ status: "ocr_running", ocr_operation_id: operationUrl, error: null })
      .eq("id", id);
    return NextResponse.json({ ok: true, status: "ocr_running" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await admin.from("guard_uploads").update({ status: "failed", error: message }).eq("id", id);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
