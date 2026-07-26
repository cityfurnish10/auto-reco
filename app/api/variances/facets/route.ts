// GET /api/variances/facets — the distinct variance_name and responsible values
// present for a given scope, with counts.
//
// WHY THIS EXISTS: the digest's "Top Gap" line tells an admin that 57 losses are
// all the same problem, and until now there was no way to isolate those 57 —
// variance_name was neither a filter nor covered by the free-text search. Same
// for `responsible`, which the engine computes on every row and the UI rendered
// in exactly one modal footer, despite triage being fundamentally a routing job.
//
// The options are derived from the data rather than hardcoded from the engine's
// 21 rule names, so the dropdown only ever offers filters that will return
// something, ordered by how much of the day they actually account for.
//
// Query params mirror /api/variances scoping: city, date, dates=all. RLS-scoped
// via the cookie client, so a manager's facets cover only their own city.

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export interface Facet {
  value: string;
  count: number;
}

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const city = sp.get("city");
  const allDates = sp.get("dates") === "all";
  let businessDate: string | null = sp.get("date");

  if (!businessDate && !allDates) {
    const { data: latest } = await supabase
      .from("reconciliation_runs")
      .select("business_date")
      .in("status", ["success", "partial"])
      .order("business_date", { ascending: false })
      .limit(1);
    businessDate = latest?.[0]?.business_date ?? null;
  }

  // Postgres would do this in one GROUP BY, but PostgREST has no aggregate
  // endpoint here, so we read the two columns and tally in JS. Paginated for
  // the same reason the stats route is: un-ranged selects cap at 1000 rows and
  // a day can carry several thousand, which would silently truncate the list.
  const rows: { variance_name: string; responsible: string | null; bucket: string }[] = [];
  for (let from = 0; ; from += 1000) {
    let query = supabase
      .from("variances")
      .select("variance_name, responsible, bucket")
      .range(from, from + 999);
    if (city) query = query.eq("city", city);
    if (businessDate) query = query.eq("business_date", businessDate);

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }

  // Losses are what people filter for, so rank by REAL count and surface it —
  // "Barcode not in guard register · 57 (54 losses)" is the useful label.
  const names = new Map<string, { count: number; real: number }>();
  const owners = new Map<string, { count: number; real: number }>();

  for (const r of rows) {
    const isReal = r.bucket === "REAL";
    const n = names.get(r.variance_name) ?? { count: 0, real: 0 };
    n.count += 1;
    if (isReal) n.real += 1;
    names.set(r.variance_name, n);

    if (r.responsible) {
      const o = owners.get(r.responsible) ?? { count: 0, real: 0 };
      o.count += 1;
      if (isReal) o.real += 1;
      owners.set(r.responsible, o);
    }
  }

  const toList = (m: Map<string, { count: number; real: number }>) =>
    [...m.entries()]
      .map(([value, v]) => ({ value, count: v.count, real: v.real }))
      .sort((a, b) => b.real - a.real || b.count - a.count || a.value.localeCompare(b.value));

  return NextResponse.json({
    businessDate,
    total: rows.length,
    varianceNames: toList(names),
    responsibles: toList(owners),
  });
}
