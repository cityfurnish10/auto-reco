"use client";

// Historical Analytics (PRD 5.5 / master-plan Phase 6). No Stitch design
// exists for this screen, so it's built to the shared design tokens. Trends
// use deterministic sample series (no historical DB yet); variance-type and
// source-reliability views read the real engine output from the last run.

import { useMemo, useState } from "react";
import { useDemoStore } from "@/lib/demo-store";
import { CITIES, CITY_SUMMARIES, OVERALL, type City } from "@/lib/sample-data";

type Range = 30 | 60 | 90;

const CITY_COLOR: Record<City, string> = {
  BANGALORE: "#16a34a",
  MUMBAI: "#2563eb",
  PUNE: "#9333ea",
  DELHI: "#f59e0b",
  HYDRABAD: "#ba1a1a",
};

// Which source each variance name primarily implicates (for the reliability
// view). Heuristic mapping over the engine's variance vocabulary.
const SOURCE_OF: Record<string, "Odoo" | "DT" | "Sheet" | "Physical"> = {
  "Odoo-Only Entry — No Floor Record": "Odoo",
  "Register/DT Logged — Not in Odoo": "Odoo",
  "Register-Confirmed, No Odoo Record": "Odoo",
  "Pickup Confirmed — Odoo Not Closed": "Odoo",
  "Odoo Update Pending — Movement Confirmed": "Odoo",
  "Odoo Update Pending — Cross-Check": "Odoo",
  "Fake Scan Risk": "DT",
  "DT-Only — Fake Scan Risk": "DT",
  "Sheet-Only Dispatch — No Trail": "Sheet",
  "Gate-Only Dispatch — No Ops/Odoo Trail": "Physical",
  "Ops-Sheet Confirmed — Gate Log Missing": "Physical",
  "Physical + Odoo Agree — No Register/DT": "Physical",
};

const SOURCE_COLOR: Record<string, string> = {
  Odoo: "#9333ea",
  DT: "#2563eb",
  Sheet: "#f59e0b",
  Physical: "#16a34a",
};

// Deterministic pseudo-trend: wobble around a city's current accuracy so the
// chart is stable across renders (seeded by city + day index).
function seriesFor(city: City, base: number, days: number): number[] {
  const out: number[] = [];
  let seed = city.length * 7 + base;
  for (let i = 0; i < days; i++) {
    seed = (seed * 9301 + 49297) % 233280;
    const wobble = (seed / 233280 - 0.5) * 6; // ±3%
    const drift = ((i / days) - 0.5) * 2; // slight trend toward today's value
    out.push(Math.max(70, Math.min(99.5, base + wobble - drift)));
  }
  out[out.length - 1] = base; // anchor last point to current accuracy
  return out;
}

export default function AnalyticsPage() {
  const { lastRun } = useDemoStore();
  const [range, setRange] = useState<Range>(30);
  const [activeCities, setActiveCities] = useState<Set<City>>(new Set(CITIES));

  const series = useMemo(
    () =>
      CITIES.map((city) => ({
        city,
        points: seriesFor(
          city,
          CITY_SUMMARIES.find((c) => c.city === city)!.accuracy,
          range
        ),
      })),
    [range]
  );

  const varianceBreakdown = useMemo(() => {
    if (!lastRun) return [];
    return Object.entries(lastRun.byVariance).sort((a, b) => b[1] - a[1]);
  }, [lastRun]);

  const sourceReliability = useMemo(() => {
    const tally: Record<string, number> = { Odoo: 0, DT: 0, Sheet: 0, Physical: 0 };
    if (lastRun) {
      for (const v of lastRun.realVariances) {
        const src = SOURCE_OF[v.variance_name];
        if (src) tally[src] += 1;
      }
    }
    const total = Object.values(tally).reduce((s, n) => s + n, 0) || 1;
    return Object.entries(tally)
      .map(([source, count]) => ({ source, count, pct: (count / total) * 100 }))
      .sort((a, b) => b.count - a.count);
  }, [lastRun]);

  const maxVariance = varianceBreakdown[0]?.[1] ?? 1;

  // Chart geometry
  const W = 720;
  const H = 240;
  const PAD = 32;
  const yMin = 70;
  const yMax = 100;
  const x = (i: number, n: number) =>
    PAD + (i / (n - 1)) * (W - PAD * 2);
  const y = (v: number) =>
    H - PAD - ((v - yMin) / (yMax - yMin)) * (H - PAD * 2);

  function toggleCity(city: City) {
    setActiveCities((prev) => {
      const next = new Set(prev);
      if (next.has(city)) next.delete(city);
      else next.add(city);
      return next;
    });
  }

  return (
    <div className="p-container-margin space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="font-headline text-xl text-text-primary mb-1">
            Historical Analytics
          </h1>
          <p className="text-text-muted text-sm">
            Accuracy trends, recurring variance types, and source reliability
            across all cities.
          </p>
        </div>
        <div className="bg-surface-elevated rounded-control p-1 flex">
          {([30, 60, 90] as Range[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={
                range === r
                  ? "px-4 py-1.5 text-sm font-medium rounded-control bg-surface-card shadow-card"
                  : "px-4 py-1.5 text-sm text-text-secondary rounded-control hover:bg-surface-card transition-colors duration-150"
              }
            >
              {r}d
            </button>
          ))}
        </div>
      </div>

      {/* Stat row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="kpi-tile card-hover">
          <p className="kpi-label">Avg Accuracy</p>
          <p className="kpi-value mt-2">{OVERALL.avgAccuracy}%</p>
        </div>
        <div className="kpi-tile kpi-tile--success card-hover">
          <p className="kpi-label">Best City</p>
          <p className="text-2xl text-success mt-2">
            {CITY_SUMMARIES[0].city}
          </p>
        </div>
        <div className="kpi-tile kpi-tile--danger card-hover">
          <p className="kpi-label">Needs Attention</p>
          <p className="text-2xl text-danger mt-2">
            {CITY_SUMMARIES[CITY_SUMMARIES.length - 1].city}
          </p>
        </div>
        <div className="kpi-tile kpi-tile--accent card-hover">
          <p className="kpi-label">REAL (last run)</p>
          <p className="kpi-value mt-2">{lastRun ? lastRun.realCount : "—"}</p>
        </div>
      </div>

      {/* Accuracy trend chart */}
      <div className="card p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-headline text-lg text-text-primary">
            Accuracy Trend — last {range} days
          </h3>
          <div className="flex flex-wrap gap-2">
            {CITIES.map((city) => (
              <button
                key={city}
                onClick={() => toggleCity(city)}
                className={`flex items-center gap-1.5 text-xs font-semibold px-2 py-1 rounded-full border transition-colors duration-150 ${
                  activeCities.has(city)
                    ? "border-border bg-surface-elevated"
                    : "border-transparent opacity-40"
                }`}
              >
                <span
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: CITY_COLOR[city] }}
                ></span>
                {city}
              </button>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="w-full"
            style={{ minWidth: 600 }}
          >
            {/* gridlines */}
            {[70, 80, 90, 100].map((gv) => (
              <g key={gv}>
                <line
                  x1={PAD}
                  x2={W - PAD}
                  y1={y(gv)}
                  y2={y(gv)}
                  stroke="var(--border-color)"
                  strokeWidth={1}
                />
                <text
                  x={4}
                  y={y(gv) + 4}
                  fontSize={10}
                  fill="var(--text-muted)"
                >
                  {gv}%
                </text>
              </g>
            ))}
            {/* lines */}
            {series
              .filter((s) => activeCities.has(s.city))
              .map((s) => {
                const d = s.points
                  .map(
                    (v, i) =>
                      `${i === 0 ? "M" : "L"} ${x(i, s.points.length).toFixed(1)} ${y(v).toFixed(1)}`
                  )
                  .join(" ");
                return (
                  <path
                    key={s.city}
                    d={d}
                    fill="none"
                    stroke={CITY_COLOR[s.city]}
                    strokeWidth={2}
                    strokeLinejoin="round"
                  />
                );
              })}
          </svg>
        </div>
      </div>

      {/* Two-column: variance types + source reliability */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card p-6">
          <h3 className="font-headline text-lg text-text-primary mb-1">
            Recurring Variance Types
          </h3>
          <p className="text-sm text-text-muted mb-4">
            From the latest reconciliation run across all cities.
          </p>
          {varianceBreakdown.length === 0 ? (
            <p className="text-sm text-text-muted py-8 text-center">
              No run yet — trigger Run Reconciliation to populate.
            </p>
          ) : (
            <div className="space-y-3">
              {varianceBreakdown.map(([name, count]) => (
                <div key={name}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-text-primary truncate pr-2">{name}</span>
                    <span className="font-bold text-text-primary">{count}</span>
                  </div>
                  <div className="h-2 w-full bg-surface-elevated rounded-full overflow-hidden">
                    <div
                      className="h-full bg-accent"
                      style={{ width: `${(count / maxVariance) * 100}%` }}
                    ></div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card p-6">
          <h3 className="font-headline text-lg text-text-primary mb-1">
            Source Reliability
          </h3>
          <p className="text-sm text-text-muted mb-4">
            Which source deviates most (share of REAL variances it implicates).
          </p>
          {!lastRun ? (
            <p className="text-sm text-text-muted py-8 text-center">
              No run yet — trigger Run Reconciliation to populate.
            </p>
          ) : (
            <div className="space-y-4">
              {sourceReliability.map(({ source, count, pct }) => (
                <div key={source}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-text-primary font-semibold">
                      {source}
                    </span>
                    <span className="text-text-muted">
                      {count} ({pct.toFixed(0)}%)
                    </span>
                  </div>
                  <div className="h-2.5 w-full bg-surface-elevated rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${pct}%`,
                        backgroundColor: SOURCE_COLOR[source],
                      }}
                    ></div>
                  </div>
                </div>
              ))}
              <p className="text-xs text-text-muted pt-2">
                Higher share = that source most often disagrees with the floor.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
