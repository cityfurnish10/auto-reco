// GET/PATCH /api/uploads/guard/[id]. GET fetches the current upload + grid
// (e.g. on page refresh). PATCH is the reviewer's confirm-and-correct step —
// saves the (possibly edited) rows and advances status to 'processed'. Both
// use the cookie-bound client; the guard_uploads RLS policies (select/update,
// the latter added in 0003_guard_ocr_review.sql) are the real authorization
// boundary.

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentAppUser } from "@/lib/db/current-user";
import type { ParsedGuardRow } from "@/lib/db/schema";

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

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const appUser = await getCurrentAppUser();
  if (!appUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { rows?: ParsedGuardRow[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const rows = body.rows;
  if (!Array.isArray(rows)) {
    return NextResponse.json({ error: "rows array is required" }, { status: 400 });
  }

  const validRows = rows.filter((r) => r.cells?.barcode?.trim() && r.direction);
  if (validRows.length === 0) {
    return NextResponse.json(
      { error: "at least one row needs a non-empty barcode and a confirmed direction" },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("guard_uploads")
    .update({
      parsed_rows: rows,
      rows_valid: validRows.length,
      status: "processed",
      reviewed_by: appUser.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select()
    .single();

  if (error) {
    const status = error.code === "PGRST116" ? 403 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }
  return NextResponse.json({ data });
}
