// GET /api/runs — list reconciliation runs (newest first).
// Query params: status, date (business_date exact), dateFrom, dateTo,
// limit (default 20, max 100).

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
  const limit = Math.min(100, Math.max(1, Number(sp.get("limit")) || 20));

  let query = supabase
    .from("reconciliation_runs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  const status = sp.get("status");
  if (status) query = query.eq("status", status);

  const businessDate = sp.get("date");
  if (businessDate) query = query.eq("business_date", businessDate);

  const dateFrom = sp.get("dateFrom");
  if (dateFrom) query = query.gte("business_date", dateFrom);

  const dateTo = sp.get("dateTo");
  if (dateTo) query = query.lte("business_date", dateTo);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data });
}
