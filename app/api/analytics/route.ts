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
import { accuracyOf, daysBefore, dailyTotals, scorable, type StatRow } from "@/lib/stats/accuracy";
import { readCityStats } from "@/lib/stats/city-stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cityAggregate(rows: StatRow[], from: string, to: string) {
  return CITIES.map((city) => {
    let movements = 0;
    let real = 0;
    let high = 0;
    for (const r of rows) {
      // `scorable` carries the shut-warehouse exclusion the leaderboard and the
      // daily trend below both use — one rule, one home.
      if (r.city !== city || !scorable(r, from, to)) continue;
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
  let rows: StatRow[];
  try {
    rows = await readCityStats(db);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  if (rows.length === 0) {
    return NextResponse.json({ empty: true });
  }

  const dates = [...new Set(rows.map((r) => r.business_date))].sort(); // ascending
  const maxDate = dates[dates.length - 1];

  // Overall accuracy per day (last 30 days present in the data).
  //
  // ON THE SAME BASIS AS EVERY OTHER FIGURE ON THIS PAGE. This loop used to sum
  // the raw rows with no shut-warehouse exclusion, while the KPI tile above the
  // chart and the per-city chart beside it both excluded them — so one screen
  // printed two accuracies for one day under one word. Measured 2026-07-30:
  // the trend bar read 89.7% where the tile's basis gives 82.8%, a 6.9pp gap
  // bought entirely by 278 movements from three warehouses that were shut.
  const cutoff = daysBefore(maxDate, 29);
  const byDate = dailyTotals(rows, cutoff, maxDate);
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
