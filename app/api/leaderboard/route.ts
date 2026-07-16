// GET /api/leaderboard — ranks the 5 cities by accuracy rate
// (REAL variances / total movements) across four windows: latest reco, last 7
// days, last 30 days, and overall.
//
// Reads the run_city_stats rollup (persisted per city at reconcile time — see
// lib/db/persist.ts saveCityStats). Uses the SERVICE-ROLE client so the board
// shows ALL cities regardless of the viewer's role (a leaderboard is inherently
// comparative; the sidebar already exposes it to admins and managers). Any
// authenticated user may read it; no city scoping here by design.
//
// Windows are anchored to the most recent business_date in the data (not the
// wall clock), so "last 7 days" means the 7 most recent days that have data.

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { CITIES } from "@/lib/sample-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface StatRow {
  business_date: string;
  city: string;
  movements: number;
  real_count: number;
  high_count: number;
}

interface LbRow {
  rank: number;
  city: string;
  movements: number;
  real: number;
  high: number;
  accuracy: number | null; // % ; null when the city had no movements in the window
  trend: "up" | "down" | "flat";
}

interface WindowOut {
  label: string;
  from: string | null;
  to: string | null;
  cities: LbRow[];
}

// YYYY-MM-DD string, n days before the given date (UTC-safe).
function daysBefore(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function clampPct(x: number): number {
  return Math.round(Math.max(0, Math.min(100, x)) * 10) / 10;
}

// Aggregate rows within [from, to] (inclusive, string comparison works for ISO
// dates) into per-city totals.
function aggregate(rows: StatRow[], from: string, to: string) {
  const map = new Map<string, { movements: number; real: number; high: number }>();
  for (const r of rows) {
    if (r.business_date < from || r.business_date > to) continue;
    const a = map.get(r.city) ?? { movements: 0, real: 0, high: 0 };
    a.movements += r.movements;
    a.real += r.real_count;
    a.high += r.high_count;
    map.set(r.city, a);
  }
  return map;
}

const accuracyOf = (movements: number, real: number): number | null =>
  movements > 0 ? clampPct((1 - real / movements) * 100) : null;

// Build a ranked window from a current aggregate + a previous-window aggregate
// (for the trend arrow).
function buildWindow(
  label: string,
  from: string | null,
  to: string | null,
  cur: Map<string, { movements: number; real: number; high: number }>,
  prev: Map<string, { movements: number; real: number; high: number }>
): WindowOut {
  const rows = CITIES.map((city) => {
    const c = cur.get(city) ?? { movements: 0, real: 0, high: 0 };
    const acc = accuracyOf(c.movements, c.real);
    const p = prev.get(city);
    const prevAcc = p ? accuracyOf(p.movements, p.real) : null;
    let trend: "up" | "down" | "flat" = "flat";
    if (acc !== null && prevAcc !== null) {
      const delta = acc - prevAcc;
      trend = delta > 0.1 ? "up" : delta < -0.1 ? "down" : "flat";
    }
    return {
      city,
      movements: c.movements,
      real: c.real,
      high: c.high,
      accuracy: acc,
      varianceRate: c.movements > 0 ? c.real / c.movements : Infinity,
      trend,
    };
  });

  // Rank: lowest variance rate first; ties → fewer REAL → more movements →
  // city name. Cities with no movements (rate = Infinity) fall to the bottom.
  rows.sort(
    (a, b) =>
      a.varianceRate - b.varianceRate ||
      a.real - b.real ||
      b.movements - a.movements ||
      a.city.localeCompare(b.city)
  );

  return {
    label,
    from,
    to,
    cities: rows.map((r, i) => ({
      rank: i + 1,
      city: r.city,
      movements: r.movements,
      real: r.real,
      high: r.high,
      accuracy: r.accuracy,
      trend: r.trend,
    })),
  };
}

export async function GET() {
  const me = await getCurrentAppUser();
  if (!me) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = createAdminClient();
  const { data, error } = await db
    .from("run_city_stats")
    .select("business_date, city, movements, real_count, high_count");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as StatRow[];
  const dates = [...new Set(rows.map((r) => r.business_date))].sort(); // ascending
  if (dates.length === 0) {
    return NextResponse.json({ empty: true, windows: null });
  }
  const maxDate = dates[dates.length - 1];
  const minDate = dates[0];
  const secondDate = dates.length > 1 ? dates[dates.length - 2] : null;

  const windows = {
    latest: buildWindow(
      "Latest Reconciliation",
      maxDate,
      maxDate,
      aggregate(rows, maxDate, maxDate),
      secondDate ? aggregate(rows, secondDate, secondDate) : new Map()
    ),
    last7: buildWindow(
      "Last 7 Days",
      daysBefore(maxDate, 6),
      maxDate,
      aggregate(rows, daysBefore(maxDate, 6), maxDate),
      aggregate(rows, daysBefore(maxDate, 13), daysBefore(maxDate, 7))
    ),
    last30: buildWindow(
      "Last 30 Days",
      daysBefore(maxDate, 29),
      maxDate,
      aggregate(rows, daysBefore(maxDate, 29), maxDate),
      aggregate(rows, daysBefore(maxDate, 59), daysBefore(maxDate, 30))
    ),
    overall: buildWindow(
      "Overall",
      minDate,
      maxDate,
      aggregate(rows, minDate, maxDate),
      new Map() // no prior period for all-time
    ),
  };

  return NextResponse.json({ empty: false, latestDate: maxDate, windows });
}
