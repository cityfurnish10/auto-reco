"use client";

import { useMemo, useState } from "react";
import { useLeaderboard, type WindowKey } from "@/lib/hooks/use-leaderboard";
import { Icon } from "@/components/icon";

const TREND_ICON = {
  up: { icon: "trending_up", cls: "text-success" },
  down: { icon: "trending_down", cls: "text-danger" },
  flat: { icon: "trending_flat", cls: "text-text-muted" },
};

const WINDOWS: { key: WindowKey; label: string }[] = [
  { key: "latest", label: "Latest" },
  { key: "last7", label: "7 Days" },
  { key: "last30", label: "30 Days" },
  { key: "overall", label: "Overall" },
];

const pct = (v: number | null) => (v === null ? "—" : `${v}%`);

export default function LeaderboardPage() {
  const { data, loading, error } = useLeaderboard();
  const [windowKey, setWindowKey] = useState<WindowKey>("latest");

  const win = data?.windows?.[windowKey] ?? null;
  const rows = useMemo(() => win?.cities ?? [], [win]);

  const totalMovements = rows.reduce((s, r) => s + r.movements, 0);
  const totalReal = rows.reduce((s, r) => s + r.real, 0);
  const avgAccuracy =
    totalMovements > 0
      ? Math.round(Math.max(0, (1 - totalReal / totalMovements) * 100) * 10) / 10
      : null;
  const topWithData = rows.find((r) => r.accuracy !== null) ?? null;

  function exportCsv() {
    const header = "Rank,City,Accuracy %,Movements,REAL Variances,High,Trend\n";
    const body = rows
      .map((r) =>
        [r.rank, r.city, r.accuracy ?? "", r.movements, r.real, r.high, r.trend].join(",")
      )
      .join("\n");
    const blob = new Blob([header + body], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `city_leaderboard_${windowKey}_${data?.latestDate ?? "latest"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const isEmpty = !loading && (data?.empty || rows.length === 0);

  return (
    <div className="p-container-margin space-y-6">
      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="font-headline text-xl text-text-primary mb-1">
            City Leaderboard
          </h1>
          <p className="text-text-muted text-sm">
            Cities ranked by reconciliation accuracy — REAL variances per movement.
            {win?.to ? ` ${win.label} (through ${win.to}).` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="bg-surface-elevated rounded-control p-1 flex">
            {WINDOWS.map((w) => (
              <button
                key={w.key}
                onClick={() => setWindowKey(w.key)}
                className={
                  windowKey === w.key
                    ? "px-4 py-1.5 text-sm font-medium rounded-control bg-surface-card shadow-card"
                    : "px-4 py-1.5 text-sm text-text-secondary rounded-control hover:bg-surface-card transition-colors duration-150"
                }
              >
                {w.label}
              </button>
            ))}
          </div>
          <button onClick={exportCsv} disabled={rows.length === 0} className="btn btn-primary disabled:opacity-50">
            <Icon name="download" size={18} />
            Export CSV
          </button>
        </div>
      </header>

      {error && (
        <div className="card p-4 bg-danger-soft border border-danger/20 text-sm text-danger font-semibold">
          {error}
        </div>
      )}

      {/* KPI Row */}
      <section className="grid grid-cols-1 md:grid-cols-4 gap-gutter">
        <div className="kpi-tile kpi-tile--success card-hover flex flex-col justify-between">
          <div className="flex items-start justify-between">
            <span className="kpi-label">Top Performer</span>
            <Icon name="workspace_premium" size={22} className="text-[#b9aa83]" />
          </div>
          <div className="mt-4">
            <h3 className="text-xl font-bold text-text-primary">
              {topWithData?.city ?? "—"}
            </h3>
            <div className="flex items-center gap-2 text-xs font-semibold text-success">
              <Icon name="verified" size={14} />
              {pct(topWithData?.accuracy ?? null)} Accuracy
            </div>
          </div>
        </div>

        <div className="kpi-tile card-hover flex flex-col justify-between">
          <div className="flex items-start justify-between">
            <span className="kpi-label">Total Movements</span>
            <Icon name="inventory_2" size={22} className="text-accent" />
          </div>
          <div className="mt-4">
            <h3 className="kpi-value">{totalMovements.toLocaleString()}</h3>
            <p className="text-xs text-text-muted">IN + OUT across all cities</p>
          </div>
        </div>

        <div className="kpi-tile kpi-tile--danger card-hover flex flex-col justify-between">
          <div className="flex items-start justify-between">
            <span className="kpi-label">REAL Variances</span>
            <Icon name="report" size={22} className="text-danger" />
          </div>
          <div className="mt-4">
            <h3 className="kpi-value text-danger">{totalReal.toLocaleString()}</h3>
            <p className="text-xs text-text-muted">Actionable, as-found</p>
          </div>
        </div>

        <div className="kpi-tile kpi-tile--accent card-hover flex flex-col justify-between overflow-hidden relative">
          <div className="relative z-10">
            <span className="kpi-label">Avg Accuracy</span>
            <h3 className="kpi-value mt-4">{pct(avgAccuracy)}</h3>
            <p className="text-xs text-text-muted">Movement-weighted</p>
          </div>
          <div className="absolute right-0 bottom-0 opacity-10">
            <Icon name="monitoring" size={80} />
          </div>
        </div>
      </section>

      {/* Ranking Table */}
      <section className="card overflow-hidden flex flex-col">
        {isEmpty ? (
          <div className="p-12 text-center text-text-muted">
            <Icon name="leaderboard" size={40} className="mx-auto mb-3 opacity-40" />
            <p className="text-sm">
              {loading ? "Loading…" : "No reconciliation data yet — run a reconcile to populate the leaderboard."}
            </p>
          </div>
        ) : (
          <>
            {/* Mobile: card list (below md) */}
            <div className="md:hidden divide-y divide-border">
              {rows.map((r) => {
                const trend = TREND_ICON[r.trend];
                return (
                  <div key={r.city} className={`p-4 ${r.rank === 1 ? "row-gold" : ""}`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        {r.rank === 1 ? (
                          <Icon name="workspace_premium" size={20} className="text-[#b9aa83] shrink-0" />
                        ) : (
                          <span className="font-headline text-base text-text-muted shrink-0">#{r.rank}</span>
                        )}
                        <span className="font-headline text-base text-text-primary truncate">{r.city}</span>
                        <Icon name={trend.icon} size={18} className={`shrink-0 ${trend.cls}`} />
                      </div>
                      <span className="font-bold text-text-primary shrink-0">{pct(r.accuracy)}</span>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted mt-2">
                      <span>{r.movements.toLocaleString()} moves</span>
                      <span className={r.real > 0 ? "text-danger font-semibold" : ""}>{r.real} REAL</span>
                      <span>{r.high} high</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Tablet/desktop: full table (md+) */}
            <div className="overflow-x-auto hidden md:block">
              <table className="table-clean">
                <thead>
                  <tr>
                    <th className="w-20 text-center">Rank</th>
                    <th>City</th>
                    <th className="text-right">Accuracy %</th>
                    <th className="text-right">Movements</th>
                    <th className="text-right">REAL Variances</th>
                    <th className="text-center">High</th>
                    <th className="text-center">Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const trend = TREND_ICON[r.trend];
                    const noData = r.accuracy === null;
                    return (
                      <tr key={r.city} className={r.rank === 1 && !noData ? "row-gold" : ""}>
                        <td className="text-center">
                          {r.rank === 1 && !noData ? (
                            <Icon name="workspace_premium" size={22} className="text-[#b9aa83] inline-block" />
                          ) : (
                            <span className="font-headline text-base text-text-muted">{r.rank}</span>
                          )}
                        </td>
                        <td>
                          <span className="font-headline text-base text-text-primary">{r.city}</span>
                          {noData && (
                            <span className="ml-2 text-xs text-text-muted">(no movements)</span>
                          )}
                        </td>
                        <td className="text-right font-bold text-text-primary">{pct(r.accuracy)}</td>
                        <td className="text-right">{r.movements.toLocaleString()}</td>
                        <td className="text-right">{r.real}</td>
                        <td className="text-center">
                          <span className={r.high > 0 ? "badge badge-high" : "badge badge-done"}>{r.high}</span>
                        </td>
                        <td className="text-center">
                          <Icon name={trend.icon} size={20} className={`inline-block ${trend.cls}`} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className="px-6 py-3 bg-surface-elevated border-t border-border flex items-center justify-between">
          <span className="text-xs text-text-muted">
            {win ? `${win.label} • ranked by REAL variances per movement` : "—"}
          </span>
        </div>
      </section>
    </div>
  );
}
