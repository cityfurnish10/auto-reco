"use client";

import { useMemo, useState } from "react";
import { useDemoStore } from "@/lib/demo-store";
import { CITY_SUMMARIES, OVERALL } from "@/lib/sample-data";
import { Icon } from "@/components/icon";

type Range = "Day" | "Week" | "Month";

const TREND_ICON = {
  up: { icon: "trending_up", cls: "text-success" },
  down: { icon: "trending_down", cls: "text-danger" },
  flat: { icon: "trending_flat", cls: "text-text-muted" },
};

export default function LeaderboardPage() {
  const { variances } = useDemoStore();
  const [range, setRange] = useState<Range>("Day");

  const rows = useMemo(
    () =>
      [...CITY_SUMMARIES]
        .sort((a, b) => a.rank - b.rank)
        .map((c) => {
          const cityRows = variances.filter((v) => v.city === c.city);
          return {
            ...c,
            liveOpen: cityRows.filter((v) => v.status !== "CLOSED").length,
            liveClosed: cityRows.filter((v) => v.status === "CLOSED").length,
            liveHigh: cityRows.filter(
              (v) => v.severity === "HIGH" && v.status !== "CLOSED"
            ).length,
          };
        }),
    [variances]
  );

  const top = rows[0];
  const criticalTotal = rows.reduce((s, r) => s + r.liveHigh, 0);
  const closedTotal = rows.reduce((s, r) => s + r.liveClosed, 0);

  function exportCsv() {
    const header =
      "Rank,City,Station,Accuracy %,Total Items,Open Variances,Closed Variances,High Severity\n";
    const body = rows
      .map((r) =>
        [
          r.rank,
          r.city,
          r.station,
          r.accuracy,
          r.totalItems,
          r.liveOpen,
          r.liveClosed,
          r.liveHigh,
        ].join(",")
      )
      .join("\n");
    const blob = new Blob([header + body], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `city_leaderboard_${range.toLowerCase()}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="p-container-margin space-y-6">
      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="font-headline text-xl text-text-primary mb-1">
            City Leaderboard
          </h1>
          <p className="text-text-muted text-sm">
            Comparative analysis of warehouse reconciliation accuracy across
            active regions.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="bg-surface-elevated rounded-control p-1 flex">
            {(["Day", "Week", "Month"] as Range[]).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={
                  range === r
                    ? "px-4 py-1.5 text-sm font-medium rounded-control bg-surface-card shadow-card"
                    : "px-4 py-1.5 text-sm text-text-secondary rounded-control hover:bg-surface-card transition-colors duration-150"
                }
              >
                {r}
              </button>
            ))}
          </div>
          <button onClick={exportCsv} className="btn btn-primary">
            <Icon name="download" size={18} />
            Export CSV
          </button>
        </div>
      </header>

      {/* Bento Stats Row */}
      <section className="grid grid-cols-1 md:grid-cols-4 gap-gutter">
        <div className="kpi-tile kpi-tile--success card-hover flex flex-col justify-between">
          <div className="flex items-start justify-between">
            <span className="kpi-label">Top Performer</span>
            <Icon name="workspace_premium" size={22} className="text-[#b9aa83]" />
          </div>
          <div className="mt-4">
            <h3 className="text-xl font-bold text-text-primary">
              {top?.city}
            </h3>
            <div className="flex items-center gap-2 text-xs font-semibold text-success">
              <Icon name="trending_up" size={14} />
              {top?.accuracy}% Accuracy
            </div>
          </div>
        </div>

        <div className="kpi-tile card-hover flex flex-col justify-between">
          <div className="flex items-start justify-between">
            <span className="kpi-label">Total Items Scanned</span>
            <Icon name="inventory_2" size={22} className="text-accent" />
          </div>
          <div className="mt-4">
            <h3 className="kpi-value">
              {OVERALL.itemsReconciledToday.toLocaleString()}
            </h3>
            <p className="text-xs text-text-muted">
              Across {rows.length} cities (sample)
            </p>
          </div>
        </div>

        <div className="kpi-tile kpi-tile--danger card-hover flex flex-col justify-between">
          <div className="flex items-start justify-between">
            <span className="kpi-label">Critical Variances</span>
            <Icon name="report" size={22} className="text-danger" />
          </div>
          <div className="mt-4">
            <h3 className="kpi-value text-danger">{criticalTotal}</h3>
            <p className="text-xs text-text-muted">
              {closedTotal} closed so far
            </p>
          </div>
        </div>

        <div className="kpi-tile kpi-tile--accent card-hover flex flex-col justify-between overflow-hidden relative">
          <div className="relative z-10">
            <span className="kpi-label">Avg Accuracy</span>
            <h3 className="kpi-value mt-4">{OVERALL.avgAccuracy}%</h3>
            <p className="text-xs text-text-muted">
              Benchmark target: 95.0%
            </p>
          </div>
          <div className="absolute right-0 bottom-0 opacity-10">
            <Icon name="monitoring" size={80} />
          </div>
        </div>
      </section>

      {/* Ranking Table */}
      <section className="card overflow-hidden flex flex-col">
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
                  <span className="font-bold text-text-primary shrink-0">{r.accuracy}%</span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted mt-2">
                  <span>{r.totalItems.toLocaleString()} items</span>
                  <span>{r.liveOpen} open</span>
                  <span>{r.liveClosed} closed</span>
                  <span className={r.liveHigh > 0 ? "text-danger font-semibold" : ""}>{r.liveHigh} high</span>
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
                <th>City Node</th>
                <th className="text-right">Accuracy %</th>
                <th className="text-right">Total Items</th>
                <th className="text-right">Open</th>
                <th className="text-right">Closed</th>
                <th className="text-center">High Severity</th>
                <th className="text-center">Trend</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const trend = TREND_ICON[r.trend];
                return (
                  <tr key={r.city} className={r.rank === 1 ? "row-gold" : ""}>
                    <td className="text-center">
                      {r.rank === 1 ? (
                        <Icon
                          name="workspace_premium"
                          size={22}
                          className="text-[#b9aa83] inline-block"
                        />
                      ) : (
                        <span className="font-headline text-base text-text-muted">
                          {r.rank}
                        </span>
                      )}
                    </td>
                    <td>
                      <div className="flex flex-col">
                        <span className="font-headline text-base text-text-primary">
                          {r.city}
                        </span>
                        <span className="text-xs text-text-muted uppercase">
                          {r.station} • Main Warehouse
                        </span>
                      </div>
                    </td>
                    <td className="text-right font-bold text-text-primary">
                      {r.accuracy}%
                    </td>
                    <td className="text-right">
                      {r.totalItems.toLocaleString()}
                    </td>
                    <td className="text-right">{r.liveOpen}</td>
                    <td className="text-right">{r.liveClosed}</td>
                    <td className="text-center">
                      <span className={r.liveHigh > 0 ? "badge badge-high" : "badge badge-done"}>
                        {r.liveHigh}
                      </span>
                    </td>
                    <td className="text-center">
                      <Icon
                        name={trend.icon}
                        size={20}
                        className={`inline-block ${trend.cls}`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="px-6 py-3 bg-surface-elevated border-t border-border flex items-center justify-between">
          <span className="text-xs text-text-muted">
            Showing all {rows.length} active city nodes • {range} view (sample
            data)
          </span>
        </div>
      </section>
    </div>
  );
}
