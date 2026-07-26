// GET /api/variances — filtered, paginated variance list.
// Uses the cookie-bound server client so results are RLS-scoped: managers only
// ever see their own city's rows (variances_select policy), admins see all.
//
// Query params (all optional): city, date (business_date exact match),
// dateFrom, dateTo, bucket (REAL|INFO), source (Odoo|DT|Sheet|Physical|Cross —
// maps to variance_source), priority (High|Medium|Info), status
// (open|in_progress|closed), direction (IN|OUT|CROSS), q (free-text search
// across barcode / ticket_id / so_number / product / customer), page (1-based,
// default 1), pageSize (default 50, max 200), dates=all (opt out of the
// default single-date scoping — see below).
//
// DATE SCOPING: with no date/dateFrom/dateTo this route used to return every
// variance ever recorded, while the KPI tiles rendered above the same table
// describe exactly one run. "Open: 54" and a table of 3,000 rows were counting
// different universes. Absent an explicit date the route now resolves the
// latest run's business_date and scopes to it, and reports which date that was
// as `businessDate`. Callers that genuinely want every date (the free-text
// search, which must find a barcode whatever night it landed on) pass
// dates=all.

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
  const page = Math.max(1, Number(sp.get("page")) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(sp.get("pageSize")) || 50));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  // Resolve the effective business date before building the query (see the
  // DATE SCOPING note above).
  const requestedDate = sp.get("date");
  const dateFrom = sp.get("dateFrom");
  const dateTo = sp.get("dateTo");
  const allDates = sp.get("dates") === "all";

  let businessDate: string | null = requestedDate;
  if (!businessDate && !dateFrom && !dateTo && !allDates) {
    // Order by business_date, not created_at: a re-check pass for an older day
    // is created later but is not the latest *day*.
    const { data: latest, error: latestErr } = await supabase
      .from("reconciliation_runs")
      .select("business_date")
      .in("status", ["success", "partial"])
      .order("business_date", { ascending: false })
      .limit(1);
    if (latestErr) {
      return NextResponse.json({ error: latestErr.message }, { status: 500 });
    }
    businessDate = latest?.[0]?.business_date ?? null;
  }

  let query = supabase
    .from("variances")
    .select("*", { count: "exact" })
    .order("business_date", { ascending: false })
    .order("last_seen_at", { ascending: false })
    .range(from, to);

  const city = sp.get("city");
  if (city) query = query.eq("city", city);

  if (businessDate) query = query.eq("business_date", businessDate);
  if (dateFrom) query = query.gte("business_date", dateFrom);
  if (dateTo) query = query.lte("business_date", dateTo);

  const bucket = sp.get("bucket");
  if (bucket) query = query.eq("bucket", bucket);

  const source = sp.get("source");
  if (source) query = query.eq("variance_source", source);

  const priority = sp.get("priority");
  if (priority) query = query.eq("priority", priority);

  const status = sp.get("status");
  if (status) query = query.eq("status", status);

  const direction = sp.get("direction");
  if (direction) query = query.eq("direction", direction);

  // Free-text search — case-insensitive substring across the identifier fields.
  // Strip characters that would break PostgREST's or()/ilike grammar so the
  // term is treated as a literal.
  const q = sp.get("q")?.trim();
  if (q) {
    const safe = q.replace(/[%,()*\\]/g, " ").trim();
    if (safe) {
      query = query.or(
        [
          `barcode.ilike.%${safe}%`,
          `ticket_id.ilike.%${safe}%`,
          `so_number.ilike.%${safe}%`,
          `product.ilike.%${safe}%`,
          `customer.ilike.%${safe}%`,
        ].join(",")
      );
    }
  }

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
    // The date actually applied — null only when spanning every date. The UI
    // labels the table with this so "blank" is never ambiguous.
    businessDate,
    dateScope: businessDate ? "day" : allDates ? "all" : dateFrom || dateTo ? "range" : "all",
  });
}
