"use client";

// Historical accuracy analytics — real data from /api/analytics (run_city_stats).
// Two hand-built bar charts (no chart library): a daily accuracy trend and a
// per-city accuracy comparison, each over a 7-day / 30-day window.

import { useMemo, useState } from "react";
import { useAnalytics, type DayPoint } from "@/lib/hooks/use-analytics";
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
// The axis is floored at AXIS_MIN so the useful band spans the full bar height
// (98% vs 82% stays legible). That is a legitimate choice for this data, but it
// exaggerates differences, so the gridlines below draw the floor explicitly
// instead of leaving it to a caption — a chart whose baseline is not zero has
// to say so on the chart.
const AXIS_MIN = 60;
const TICKS = [100, 90, 80, 70, AXIS_MIN];

function barHeight(acc: number | null): number {
  if (acc === null) return 0;
  return Math.max(2, Math.min(100, ((acc - AXIS_MIN) / (100 - AXIS_MIN)) * 100));
}
const ddmm = (d: string) => d.slice(8, 10); // day-of-month for the x tick

// A day with no run at all, as opposed to a day that ran and scored badly.
interface TrendPoint extends DayPoint {
  missing?: boolean;
}

// Build a CONTINUOUS date axis across the window. The API only returns days
// that produced stats, so a night the pipeline never ran was simply absent —
// and an absent day is spliced out, leaving a trend line that looks unbroken
// across the exact gap you needed to see. Missing days now occupy their slot.
function buildSeries(days: DayPoint[], nDays: number): TrendPoint[] {
  if (days.length === 0) return [];
  const present = new Map(days.map((d) => [d.date, d]));
  const endMs = Date.parse(`${days[days.length - 1].date}T00:00:00Z`);
  const out: TrendPoint[] = [];
  for (let i = nDays - 1; i >= 0; i--) {
    const iso = new Date(endMs - i * 86_400_000).toISOString().slice(0, 10);
    out.push(
      present.get(iso) ?? { date: iso, movements: 0, real: 0, accuracy: null, missing: true }
    );
  }
  return out;
}

export default function AnalyticsPage() {
  const { data, loading, error } = useAnalytics();
  const [win, setWin] = useState<Win>("7");
  const nDays = win === "7" ? 7 : 30;

  const days = useMemo(() => buildSeries(data?.days ?? [], nDays), [data, nDays]);
  const missingDays = days.filter((d) => d.missing).length;
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
            <div className="flex items-center justify-between mb-6 gap-3">
              <h3 className="font-headline text-lg text-text-primary">Daily Accuracy Trend</h3>
              {missingDays > 0 && (
                <span className="badge badge-medium" title="Days with no reconciliation stats">
                  <Icon name="warning" size={14} />
                  {missingDays} day{missingDays === 1 ? "" : "s"} with no run
                </span>
              )}
            </div>
            <div className="overflow-x-auto">
              {/* Grid + bars share one stacking context so the ticks sit behind
                  the bars rather than being a separate column that drifts. */}
              <div className="relative pl-9" style={{ minWidth: days.length * 28 }}>
                <div className="relative h-52">
                  {TICKS.map((t) => (
                    <div
                      key={t}
                      className="absolute inset-x-0 border-t border-border/70 flex items-center"
                      style={{ bottom: `${((t - AXIS_MIN) / (100 - AXIS_MIN)) * 100}%` }}
                    >
                      <span className="absolute -left-9 -translate-y-1/2 text-xs text-text-muted tabular-nums">
                        {t}%
                      </span>
                    </div>
                  ))}
                  <div className="absolute inset-0 flex items-end gap-2">
                    {days.map((d) => (
                      <div
                        key={d.date}
                        className="flex-1 flex flex-col items-center justify-end h-full min-w-[20px]"
                        title={
                          d.missing
                            ? `${d.date} — no reconciliation run`
                            : `${d.date} — ${pct(d.accuracy)} (${d.real} REAL / ${d.movements} moves)`
                        }
                      >
                        {d.missing ? (
                          // A dashed full-height ghost, not a zero-height bar: a
                          // night that never ran must not read as 0% accuracy.
                          <div className="w-full max-w-[26px] h-full rounded-t border border-dashed border-text-disabled/60 bg-surface-elevated/40 flex items-end justify-center">
                            <Icon name="close" size={12} className="text-text-disabled mb-1" />
                          </div>
                        ) : (
                          <>
                            <span className="text-xs font-semibold text-text-secondary mb-1 tabular-nums">
                              {d.accuracy === null ? "" : Math.round(d.accuracy)}
                            </span>
                            <div
                              className="w-full max-w-[26px] rounded-t transition-all"
                              style={{
                                height: `${barHeight(d.accuracy)}%`,
                                backgroundColor: bandColor(d.accuracy),
                              }}
                            ></div>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="flex gap-2 mt-1">
                  {days.map((d) => (
                    <span
                      key={d.date}
                      className="flex-1 min-w-[20px] text-center text-xs text-text-muted tabular-nums"
                    >
                      {ddmm(d.date)}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <p className="text-xs text-text-muted mt-3">
              Overall accuracy per day (all cities). Green ≥95%, amber ≥90%, red below.{" "}
              <b>The axis starts at {AXIS_MIN}%</b>, not zero — differences look larger than
              they are. A dashed column is a day with no reconciliation run, which is not the
              same as a day that scored zero.
            </p>
          </section>

          {/* Per-city accuracy */}
          <section className="card p-6">
            <div className="flex items-center justify-between mb-6">
              <h3 className="font-headline text-lg text-text-primary">Accuracy by City</h3>
              <span className="text-xs text-text-muted">{win}-day window</span>
            </div>
            <div className="relative pl-9">
              <div className="relative h-52">
                {TICKS.map((t) => (
                  <div
                    key={t}
                    className="absolute inset-x-0 border-t border-border/70"
                    style={{ bottom: `${((t - AXIS_MIN) / (100 - AXIS_MIN)) * 100}%` }}
                  >
                    <span className="absolute -left-9 -translate-y-1/2 text-xs text-text-muted tabular-nums">
                      {t}%
                    </span>
                  </div>
                ))}
                <div className="absolute inset-0 flex items-end gap-4">
                  {cityRows.map((c) => (
                    <div
                      key={c.city}
                      className="flex-1 flex flex-col items-center justify-end h-full"
                      title={`${c.city} — ${pct(c.accuracy)} (${c.real} REAL / ${c.movements} moves)`}
                    >
                      <span className="text-xs font-bold text-text-primary mb-1 tabular-nums">
                        {pct(c.accuracy)}
                      </span>
                      <div
                        className="w-full max-w-[64px] rounded-t transition-all"
                        style={{
                          height: `${barHeight(c.accuracy)}%`,
                          backgroundColor: bandColor(c.accuracy),
                        }}
                      ></div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex gap-4 mt-2">
                {cityRows.map((c) => (
                  <div key={c.city} className="flex-1 text-center">
                    <span className="font-headline text-sm text-text-primary leading-tight block">
                      {c.city}
                    </span>
                    <span className="text-xs text-text-muted tabular-nums">
                      {c.real} REAL · {c.movements.toLocaleString()} moves
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <p className="text-xs text-text-muted mt-3">
              Axis starts at {AXIS_MIN}%. A city with very few movements can post a high
              percentage on a tiny sample — the movement count under each bar is the
              denominator.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
