// GET /api/stats/summary — dashboard KPI aggregates, replacing the hardcoded
// OVERALL / CITY_SUMMARIES sample data.
//
// Query params: date (business_date, default today). If no run exists for
// that exact date yet, falls back to the latest available run so the
// dashboard isn't empty before today's pipeline has fired.
//
// IMPORTANT: aggregates are computed from the `variances` table via the
// RLS-scoped server client — NOT from reconciliation_runs.combined (which is
// global across all cities). This is what keeps a manager's summary limited
// to their own city instead of leaking other cities' totals.

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

interface CityAgg {
  city: string;
  total: number;
  open: number;
  inProgress: number;
  closed: number;
  high: number;
  medium: number;
  info: number;
  real: number;
  infoBucket: number;
  ppBox: number; // count-only PP-box movements for the run (from run_city_stats)
  consumable: number; // count-only spare/consumable movements for the run
}

function emptyAgg(city: string): CityAgg {
  return {
    city,
    total: 0,
    open: 0,
    inProgress: 0,
    closed: 0,
    high: 0,
    medium: 0,
    info: 0,
    real: 0,
    infoBucket: 0,
    ppBox: 0,
    consumable: 0,
  };
}

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const requestedDate = req.nextUrl.searchParams.get("date") || todayISO();

  // Latest run for the requested date …
  const { data: runsForDate, error: runErr } = await supabase
    .from("reconciliation_runs")
    .select("*")
    .eq("business_date", requestedDate)
    .in("status", ["success", "partial"])
    .order("created_at", { ascending: false })
    .limit(1);
  if (runErr) return NextResponse.json({ error: runErr.message }, { status: 500 });

  let run = runsForDate?.[0] ?? null;
  let usedFallbackRun = false;

  // … or fall back to the latest run overall.
  if (!run) {
    const { data: latestRuns, error: latestErr } = await supabase
      .from("reconciliation_runs")
      .select("*")
      .in("status", ["success", "partial"])
      .order("created_at", { ascending: false })
      .limit(1);
    if (latestErr) return NextResponse.json({ error: latestErr.message }, { status: 500 });
    run = latestRuns?.[0] ?? null;
    usedFallbackRun = !!run;
  }

  if (!run) {
    return NextResponse.json({
      run: null,
      usedFallbackRun: false,
      byCity: [],
      overall: emptyAgg("ALL"),
    });
  }

  const { data: variances, error: varErr } = await supabase
    .from("variances")
    .select("city, status, priority, bucket")
    .eq("run_id", run.id);
  if (varErr) return NextResponse.json({ error: varErr.message }, { status: 500 });

  const byCityMap = new Map<string, CityAgg>();
  const overall = emptyAgg("ALL");

  for (const v of variances ?? []) {
    const agg = byCityMap.get(v.city) ?? emptyAgg(v.city);
    for (const target of [agg, overall]) {
      target.total += 1;
      if (v.status === "open") target.open += 1;
      else if (v.status === "in_progress") target.inProgress += 1;
      else if (v.status === "closed") target.closed += 1;
      if (v.priority === "High") target.high += 1;
      else if (v.priority === "Medium") target.medium += 1;
      else if (v.priority === "Info") target.info += 1;
      if (v.bucket === "REAL") target.real += 1;
      else if (v.bucket === "INFO") target.infoBucket += 1;
    }
    byCityMap.set(v.city, agg);
  }

  // Overlay count-only PP-box / consumable movements from run_city_stats for
  // this run's date (RLS-scoped: a manager sees only their own city's row).
  const { data: cityStats } = await supabase
    .from("run_city_stats")
    .select("city, pp_box_count, consumable_count")
    .eq("business_date", run.business_date);
  for (const s of cityStats ?? []) {
    const agg = byCityMap.get(s.city) ?? emptyAgg(s.city);
    agg.ppBox = s.pp_box_count ?? 0;
    agg.consumable = s.consumable_count ?? 0;
    byCityMap.set(s.city, agg);
    overall.ppBox += s.pp_box_count ?? 0;
    overall.consumable += s.consumable_count ?? 0;
  }

  return NextResponse.json({
    run: {
      id: run.id,
      business_date: run.business_date,
      run_date: run.run_date,
      status: run.status,
      created_at: run.created_at,
      completed_at: run.completed_at,
    },
    usedFallbackRun,
    byCity: [...byCityMap.values()].sort((a, b) => a.city.localeCompare(b.city)),
    overall,
  });
}
