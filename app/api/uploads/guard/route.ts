// POST /api/uploads/guard — creates a guard_uploads row and a Supabase Storage
// signed upload URL for the PDF. Uses the cookie-bound client (not the admin
// client) — RLS (guard_uploads_insert / guard_registers_insert, both added in
// 0003_guard_ocr_review.sql) is the real authorization boundary, matching the
// pattern already used by app/api/variances/[id]/route.ts.
//
// The file bytes never pass through this route or any Next.js server function
// — the browser PUTs directly to the signed URL, deliberately avoiding
// Vercel's ~4.5MB request-body ceiling (a multi-page scanned PDF can easily
// exceed that).

import { randomUUID } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentAppUser } from "@/lib/db/current-user";

export async function POST(req: NextRequest) {
  const appUser = await getCurrentAppUser();
  if (!appUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { city?: string; businessDate?: string; fileName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { city, businessDate, fileName } = body;
  if (!city || !businessDate || !fileName) {
    return NextResponse.json(
      { error: "city, businessDate, fileName are required" },
      { status: 400 }
    );
  }
  if (!fileName.toLowerCase().endsWith(".pdf")) {
    return NextResponse.json({ error: "only .pdf uploads are supported" }, { status: 400 });
  }

  const id = randomUUID();
  // Path convention storage RLS depends on: {CITY}/{business_date}/{upload_id}.pdf
  const filePath = `${city}/${businessDate}/${id}.pdf`;

  const supabase = await createClient();

  const { error: insertError } = await supabase.from("guard_uploads").insert({
    id,
    uploaded_by: appUser.id,
    file_name: fileName,
    file_path: filePath,
    city,
    business_date: businessDate,
    status: "pending",
  });
  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  const { data: signed, error: signError } = await supabase.storage
    .from("guard-registers")
    .createSignedUploadUrl(filePath);
  if (signError || !signed) {
    return NextResponse.json(
      { error: signError?.message ?? "failed to create signed upload URL" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    id,
    filePath,
    signedUrl: signed.signedUrl,
    token: signed.token,
  });
}
