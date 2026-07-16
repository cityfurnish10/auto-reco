"use client";

// Historical accuracy analytics — real data from /api/analytics (run_city_stats).
// Two hand-built bar charts (no chart library): a daily accuracy trend and a
// per-city accuracy comparison, each over a 7-day / 30-day window.

import { useMemo, useState } from "react";
import { useAnalytics } from "@/lib/hooks/use-analytics";
import { Icon } from "@/components/icon";

type Win = "7" | "30";

const pct = (v: number | null) => (v === null ? "—" : `${v}%`);

// Accuracy → colour band (reads theme-safe CSS vars).
function bandColor(acc: number | null): string {
  if (acc === null) return "var(--text-disabled)";
  if (acc >= 95) return "var(--color-success-fg)";
  if (acc >= 90) return "var(--color-warning-fg)";
  return "var(--color-error-fg)";
}
// Map accuracy to a bar height %. Floor the axis at 60% so the useful 60–100
// band spans the full bar height (a 98% vs 82% difference stays legible).
function barHeight(acc: number | null): number {
  if (acc === null) return 2;
  return Math.max(4, Math.min(100, ((acc - 60) / 40) * 100));
}
const ddmm = (d: string) => d.slice(8, 10); // day-of-month for the x tick

export default function AnalyticsPage() {
  const { data, loading, error } = useAnalytics();
  const [win, setWin] = useState<Win>("7");
  const nDays = win === "7" ? 7 : 30;

  const days = useMemo(() => (data?.days ?? []).slice(-nDays), [data, nDays]);
  const cityRows = data?.byCity?.[win === "7" ? "last7" : "last30"] ?? [];

  const totalMovements = cityRows.reduce((s, c) => s + c.movements, 0);
  const totalReal = cityRows.reduce((s, c) => s + c.real, 0);
  const avgAccuracy =
    totalMovements > 0
      ? Math.round(Math.max(0, (1 - totalReal / totalMovements) * 100) * 10) / 10
      : null;
  const withData = cityRows.filter((c) => c.accuracy !== null); // sorted best→worst by the API
  const best = withData[0] ?? null;
  const worst = withData.length > 1 ? withData[withData.length - 1] : null;

  const isEmpty = !loading && (data?.empty || cityRows.length === 0);

  return (
    <div className="p-container-margin space-y-6">
      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="font-headline text-xl text-text-primary mb-1">Historical Analytics</h1>
          <p className="text-text-muted text-sm">
            Reconciliation accuracy over time — daily trend and per-city comparison.
          </p>
        </div>
        <div className="bg-surface-elevated rounded-control p-1 flex">
          {(["7", "30"] as Win[]).map((w) => (
            <button
              key={w}
              onClick={() => setWin(w)}
              className={
                win === w
                  ? "px-4 py-1.5 text-sm font-medium rounded-control bg-surface-card shadow-card"
                  : "px-4 py-1.5 text-sm text-text-secondary rounded-control hover:bg-surface-card transition-colors duration-150"
              }
            >
              {w} Days
            </button>
          ))}
        </div>
      </header>

      {error && (
        <div className="card p-4 bg-danger-soft border border-danger/20 text-sm text-danger font-semibold">
          {error}
        </div>
      )}

      {/* KPI Row */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-gutter">
        <div className="kpi-tile kpi-tile--accent card-hover">
          <span className="kpi-label">Avg Accuracy</span>
          <h3 className="kpi-value mt-3">{pct(avgAccuracy)}</h3>
          <p className="text-xs text-text-muted">Movement-weighted, {nDays}d</p>
        </div>
        <div className="kpi-tile kpi-tile--success card-hover">
          <span className="kpi-label">Best City</span>
          <h3 className="text-xl font-bold text-text-primary mt-3">{best?.city ?? "—"}</h3>
          <p className="text-xs text-success font-semibold">{pct(best?.accuracy ?? null)}</p>
        </div>
        <div className="kpi-tile kpi-tile--danger card-hover">
          <span className="kpi-label">Needs Attention</span>
          <h3 className="text-xl font-bold text-text-primary mt-3">{worst?.city ?? "—"}</h3>
          <p className="text-xs text-danger font-semibold">{pct(worst?.accuracy ?? null)}</p>
        </div>
        <div className="kpi-tile card-hover">
          <span className="kpi-label">REAL Variances</span>
          <h3 className="kpi-value mt-3 text-danger">{totalReal.toLocaleString()}</h3>
          <p className="text-xs text-text-muted">{totalMovements.toLocaleString()} movements</p>
        </div>
      </section>

      {isEmpty ? (
        <div className="card p-12 text-center text-text-muted">
          <Icon name="monitoring" size={40} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm">
            {loading ? "Loading…" : "No reconciliation data yet — run a reconcile to populate analytics."}
          </p>
        </div>
      ) : (
        <>
          {/* Daily accuracy trend */}
          <section className="card p-6">
            <div className="flex items-center justify-between mb-6">
              <h3 className="font-headline text-lg text-text-primary">Daily Accuracy Trend</h3>
              <span className="text-xs text-text-muted">Last {days.length} day(s) with data</span>
            </div>
            <div className="overflow-x-auto">
              <div className="flex items-end gap-2 h-52 min-w-full" style={{ minWidth: days.length * 28 }}>
                {days.map((d) => (
                  <div
                    key={d.date}
                    className="flex-1 flex flex-col items-center justify-end h-full min-w-[20px]"
                    title={`${d.date} — ${pct(d.accuracy)} (${d.real} REAL / ${d.movements} moves)`}
                  >
                    <span className="text-[10px] font-semibold text-text-secondary mb-1">
                      {d.accuracy === null ? "" : Math.round(d.accuracy)}
                    </span>
                    <div
                      className="w-full max-w-[26px] rounded-t transition-all"
                      style={{ height: `${barHeight(d.accuracy)}%`, backgroundColor: bandColor(d.accuracy) }}
                    ></div>
                    <span className="text-[10px] text-text-muted mt-1">{ddmm(d.date)}</span>
                  </div>
                ))}
              </div>
            </div>
            <p className="text-xs text-text-muted mt-3">
              Overall accuracy per day (all cities). Green ≥95%, amber ≥90%, red below. Axis floored at 60%.
            </p>
          </section>

          {/* Per-city accuracy */}
          <section className="card p-6">
            <div className="flex items-center justify-between mb-6">
              <h3 className="font-headline text-lg text-text-primary">Accuracy by City</h3>
              <span className="text-xs text-text-muted">{win}-day window</span>
            </div>
            <div className="flex items-end gap-4 h-52">
              {cityRows.map((c) => (
                <div
                  key={c.city}
                  className="flex-1 flex flex-col items-center justify-end h-full"
                  title={`${c.city} — ${pct(c.accuracy)} (${c.real} REAL / ${c.movements} moves)`}
                >
                  <span className="text-xs font-bold text-text-primary mb-1">{pct(c.accuracy)}</span>
                  <div
                    className="w-full max-w-[64px] rounded-t transition-all"
                    style={{ height: `${barHeight(c.accuracy)}%`, backgroundColor: bandColor(c.accuracy) }}
                  ></div>
                  <span className="text-xs text-text-secondary mt-2 font-medium">{c.city}</span>
                  <span className="text-[10px] text-text-muted">{c.real} REAL</span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
