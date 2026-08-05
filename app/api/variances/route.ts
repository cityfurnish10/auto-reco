// GET /api/variances — filtered, paginated variance list.
// Uses the cookie-bound server client so results are RLS-scoped: managers only
// ever see their own city's rows (variances_select policy), admins see all.
//
// Query params (all optional): city, date (business_date exact match),
// dateFrom, dateTo, bucket (REAL|INFO), source (Odoo|DT|Sheet|Physical|Cross —
// maps to variance_source), priority (High|Medium|Info), status
// (open|in_progress|closed), direction (IN|OUT|CROSS), variance (exact
// variance_name), responsible (exact responsible slug), jobType (exact ops
// type, or the __NONE__ sentinel for rows with none), q (free-text search
// across barcode / ticket_id / so_number / product / customer), page (1-based,
// default 1), pageSize (default 50, max 200), dates=all (opt out of the
// default single-date scoping — see below), sort + dir (see SORTS).
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

// Sortable keys, whitelisted — the value reaches PostgREST's order() as a
// column name, so it can never come straight from the query string.
//
// `rank` names a generated column from migration 0011 that encodes MEANING
// rather than spelling: ordering priority as text gives "High, Info, Medium",
// and status gives closed-before-open because 'c' < 'o'. Both are the opposite
// of what a triage screen needs. If 0011 has not been applied the query fails
// with 42703 and we retry on the plain column, reporting sortDegraded so the UI
// can say the order is alphabetical rather than silently lying about it.
const SORTS: Record<string, { cols: string[]; rank?: string; fallback?: string[] }> = {
  date: { cols: ["business_date", "last_seen_at"] },
  city: { cols: ["city", "business_date"] },
  product: { cols: ["product", "barcode"] },
  barcode: { cols: ["barcode"] },
  ticket: { cols: ["ticket_id"] },
  source: { cols: ["variance_source", "barcode"] },
  so: { cols: ["so_number"] },
  variance: { cols: ["variance_name", "barcode"] },
  responsible: { cols: ["responsible", "barcode"] },
  jobType: { cols: ["job_type", "barcode"] },
  priority: { cols: ["priority_rank", "business_date"], rank: "priority_rank", fallback: ["priority"] },
  status: { cols: ["status_rank", "last_seen_at"], rank: "status_rank", fallback: ["status"] },
  // Age = how long this has been unresolved, so ASC (oldest first) is the
  // useful default here, unlike every other column.
  age: { cols: ["first_seen_at"] },
  updated: { cols: ["last_seen_at"] },
};

const DEFAULT_SORT = "date";

import { OPS_TYPE_NONE } from "@/lib/ui/variance-format";

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

  const sortKey = sp.get("sort") && SORTS[sp.get("sort")!] ? sp.get("sort")! : DEFAULT_SORT;
  // Age is "how long has this been unresolved", so oldest-first is the useful
  // default; everything else defaults to newest/highest first.
  const dirParam = sp.get("dir");
  const ascending =
    dirParam === "asc" ? true : dirParam === "desc" ? false : sortKey === "age";

  // Filters are identical across the sort retry, so build them once.
  const city = sp.get("city");
  const bucket = sp.get("bucket");
  const source = sp.get("source");
  const priority = sp.get("priority");
  const status = sp.get("status");
  const direction = sp.get("direction");
  const varianceName = sp.get("variance");
  const responsible = sp.get("responsible");
  const jobType = sp.get("jobType");
  const closureReason = sp.get("closureReason");
  const q = sp.get("q")?.trim();

  function build(orderCols: string[], searchDisplay: boolean) {
    let query = supabase.from("variances").select("*", { count: "exact" });

    for (const col of orderCols) {
      // nullsFirst:false keeps rows with no ticket / no SO at the bottom rather
      // than filling the first page with blanks when sorting by them.
      query = query.order(col, { ascending, nullsFirst: false });
    }
    // Deterministic tiebreak — without it Postgres may return the same row on
    // two different pages when the sort column ties across a page boundary.
    query = query.order("id", { ascending: true }).range(from, to);

    if (city) query = query.eq("city", city);
    if (businessDate) query = query.eq("business_date", businessDate);
    if (dateFrom) query = query.gte("business_date", dateFrom);
    if (dateTo) query = query.lte("business_date", dateTo);
    if (bucket) query = query.eq("bucket", bucket);
    if (source) query = query.eq("variance_source", source);
    if (priority) query = query.eq("priority", priority);
    // Comma-separated status accepted so a view can span several. The one that
    // matters is "open,in_progress": flagging a variance moves it to
    // in_progress, and the whole point of a flag is to escalate it TO the city
    // manager — whose default view filtered exactly that status out, so the
    // escalation landed somewhere nobody was looking.
    if (status) {
      const list = status.split(",").map((s) => s.trim()).filter(Boolean);
      query = list.length > 1 ? query.in("status", list) : query.eq("status", list[0]);
    }
    if (direction) query = query.eq("direction", direction);
    if (varianceName) query = query.eq("variance_name", varianceName);
    if (responsible) query = query.eq("responsible", responsible);
    // Ops type. The sentinel maps to IS NULL rather than being dropped —
    // job_type is null on a large share of rows, and a filter that cannot
    // reach them would hide real losses.
    if (jobType) {
      query = jobType === OPS_TYPE_NONE ? query.is("job_type", null) : query.eq("job_type", jobType);
    }
    // Closure reason. NOTE: callers filtering by reason must ALSO pass a status
    // — `dispute` writes closure_reason while the row is still in_progress
    // (see app/api/variances/[id]/actions.ts), so a reason-only filter would
    // pull in flagged rows that were never actually resolved.
    if (closureReason) query = query.eq("closure_reason", closureReason);

    // Free-text search — case-insensitive substring across the identifier
    // fields. Strip characters that would break PostgREST's or()/ilike grammar
    // so the term is treated as a literal.
    if (q) {
      const safe = q.replace(/[%,()*\\]/g, " ").trim();
      if (safe) {
        query = query.or(
          [
            `barcode.ilike.%${safe}%`,
            // BOTH SPELLINGS, or fixing the display would break the search.
            // The table now shows what a typed source recorded (0020), so a
            // reader copies AP8IS725090229 out of it and types that back —
            // matching only the canonical would answer "no results" for the
            // exact string we had just printed. The canonical stays in the list
            // because someone may paste an older row's folded barcode, and
            // because rows written before 0020 have nothing else to match on.
            ...(searchDisplay ? [`barcode_display.ilike.%${safe}%`] : []),
            `ticket_id.ilike.%${safe}%`,
            `so_number.ilike.%${safe}%`,
            `product.ilike.%${safe}%`,
            `customer.ilike.%${safe}%`,
          ].join(",")
        );
      }
    }
    return query;
  }

  const sort = SORTS[sortKey];
  const missingCol = (e: { code?: string; message?: string } | null) =>
    !!e && (e.code === "42703" || e.code === "PGRST204" || /does not exist|could not find/i.test(e.message ?? ""));

  let sortDegraded = false;
  let searchDisplay = true;
  let { data, error, count } = await build(sort.cols, searchDisplay);

  // Migration 0020 (barcode_display) not applied: drop it from the search and
  // retry. Without this the whole table 500s on any search term the moment the
  // code ships ahead of the migration — a strictly worse outcome than searching
  // the canonical alone, which is what it did before 0020 existed.
  if (error && missingCol(error)) {
    searchDisplay = false;
    ({ data, error, count } = await build(sort.cols, searchDisplay));
  }

  // 42703 = undefined_column: migration 0011 (priority_rank / status_rank) has
  // not been applied. Retry alphabetically rather than 500, and tell the client
  // the order is not the one it asked for.
  if (error && sort.fallback && missingCol(error)) {
    sortDegraded = true;
    ({ data, error, count } = await build(sort.fallback, searchDisplay));
  }

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
    sort: sortKey,
    dir: ascending ? "asc" : "desc",
    // True only when the requested severity/workflow order fell back to
    // alphabetical because migration 0011 is not applied.
    sortDegraded,
  });
}
