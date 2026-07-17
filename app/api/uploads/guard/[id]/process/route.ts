// POST /api/uploads/guard/[id]/process — OCR a just-uploaded register immediately
// and store its rows. Called by the upload UI right after the PDF lands in
// Storage, so the data is in the DB within seconds (no waiting for the nightly
// run). Synchronous: it downloads the PDF, runs Document Intelligence, and
// writes parsed_rows before responding.
//
// Access is RLS-scoped (a manager can only process their own city's upload); the
// OCR download + write use the service-role client.

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { processGuardUpload } from "@/lib/connectors/ocr/process";
import { azureDocIntelConfigured } from "@/lib/connectors/ocr/document-intelligence";
import type { GuardUpload } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

  // RLS-scoped read — confirms the caller may see this upload before we OCR it.
  const { data: upload, error } = await supabase
    .from("guard_uploads")
    .select("*")
    .eq("id", id)
    .single();
  if (error || !upload) {
    return NextResponse.json({ error: "upload not found or not accessible" }, { status: 404 });
  }

  if (!azureDocIntelConfigured()) {
    return NextResponse.json(
      { error: "OCR not configured (set AZURE_VISION_ENDPOINT + AZURE_VISION_API_KEY)." },
      { status: 500 }
    );
  }

  const admin = createAdminClient();
  const result = await processGuardUpload(admin, upload as GuardUpload);

  if (result.result === "processed") {
    return NextResponse.json({ ok: true, ...result });
  }
  const status = result.result === "skipped" ? 409 : 502; // skipped = file not in storage yet
  return NextResponse.json({ ok: false, ...result, error: result.reason ?? "OCR failed" }, { status });
}
