// GET /api/sources — raw source rows for a run (drilldown behind a variance).
// Query params: run_id (required), source, city, barcode, page, pageSize.

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const runId = sp.get("run_id");
  if (!runId) {
    return NextResponse.json({ error: "run_id is required" }, { status: 400 });
  }

  const page = Math.max(1, Number(sp.get("page")) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(sp.get("pageSize")) || 100));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabase
    .from("source_rows")
    .select("*", { count: "exact" })
    .eq("run_id", runId)
    .order("created_at", { ascending: false })
    .range(from, to);

  const source = sp.get("source");
  if (source) query = query.eq("source", source);

  const city = sp.get("city");
  if (city) query = query.eq("city", city);

  const barcode = sp.get("barcode");
  if (barcode) query = query.eq("barcode", barcode);

  const { data, error, count } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    data,
    page,
    pageSize,
    total: count ?? 0,
    totalPages: count ? Math.ceil(count / pageSize) : 0,
  });
}
