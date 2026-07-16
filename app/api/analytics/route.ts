// GET /api/analytics — historical accuracy analytics for the charts.
// Admin-only (analytics is gated in middleware.ts + sidebar). Reads the
// run_city_stats rollup via the service-role client and returns:
//   - days:   overall accuracy per business_date (last 30 days, ascending) for
//             the daily trend bar chart (client slices to 7 or 30).
//   - byCity: per-city accuracy aggregated over the last 7 and last 30 days for
//             the per-city comparison bar chart.
// Windows are anchored to the most recent business_date in the data.

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

function daysBefore(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
const clampPct = (x: number) => Math.round(Math.max(0, Math.min(100, x)) * 10) / 10;
const accuracyOf = (movements: number, real: number): number | null =>
  movements > 0 ? clampPct((1 - real / movements) * 100) : null;

function cityAggregate(rows: StatRow[], from: string, to: string) {
  return CITIES.map((city) => {
    let movements = 0;
    let real = 0;
    let high = 0;
    for (const r of rows) {
      if (r.city !== city || r.business_date < from || r.business_date > to) continue;
      movements += r.movements;
      real += r.real_count;
      high += r.high_count;
    }
    return { city, movements, real, high, accuracy: accuracyOf(movements, real) };
  }).sort((a, b) => (b.accuracy ?? -1) - (a.accuracy ?? -1) || a.city.localeCompare(b.city));
}

export async function GET() {
  const me = await getCurrentAppUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const db = createAdminClient();
  const { data, error } = await db
    .from("run_city_stats")
    .select("business_date, city, movements, real_count, high_count");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as StatRow[];
  if (rows.length === 0) {
    return NextResponse.json({ empty: true });
  }

  const dates = [...new Set(rows.map((r) => r.business_date))].sort(); // ascending
  const maxDate = dates[dates.length - 1];

  // Overall accuracy per day (last 30 days present in the data).
  const cutoff = daysBefore(maxDate, 29);
  const byDate = new Map<string, { movements: number; real: number }>();
  for (const r of rows) {
    if (r.business_date < cutoff) continue;
    const a = byDate.get(r.business_date) ?? { movements: 0, real: 0 };
    a.movements += r.movements;
    a.real += r.real_count;
    byDate.set(r.business_date, a);
  }
  const days = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({
      date,
      movements: v.movements,
      real: v.real,
      accuracy: accuracyOf(v.movements, v.real),
    }));

  return NextResponse.json({
    empty: false,
    latestDate: maxDate,
    days,
    byCity: {
      last7: cityAggregate(rows, daysBefore(maxDate, 6), maxDate),
      last30: cityAggregate(rows, daysBefore(maxDate, 29), maxDate),
    },
  });
}
