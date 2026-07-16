// GET /api/uploads/guard/[id] — fetch a single upload (e.g. on refresh). Uses
// the cookie-bound client; the guard_uploads RLS select policy is the real
// authorization boundary. There is no review/confirm step anymore — OCR runs in
// the background (lib/connectors/ocr/process.ts) and writes rows directly, so
// the old PATCH confirm route is gone.

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

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
