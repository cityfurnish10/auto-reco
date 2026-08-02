"use client";

import { useMemo, useState } from "react";
import { useLeaderboard, type WindowKey } from "@/lib/hooks/use-leaderboard";
import { Icon, type IconName } from "@/components/icon";
import { clampPct } from "@/lib/stats/accuracy";
import { MIN_MOVEMENTS } from "@/lib/ui/stat-captions";

const TREND_ICON: Record<string, { icon: IconName; cls: string }> = {
  up: { icon: "trending_up", cls: "text-success" },
  down: { icon: "trending_down", cls: "text-danger" },
  flat: { icon: "trending_flat", cls: "text-text-muted" },
};

// Below MIN_MOVEMENTS a percentage says more about the sample than the
// warehouse: 3 movements and 0 variances is 100%, and it was taking the trophy
// off cities running thousands of movements at 96%. The API's ranking is left
// alone — re-ordering it here would put a rank number next to a row that isn't
// in that position — but the medal goes to the best city that actually cleared
// the bar, and thin rows say so.
//
// IMPORTED, not retyped. It was declared here AND in lib/ui/stat-captions.ts,
// which is where the dashboard's "too few to compare" line reads it from — two
// copies of one threshold, so a change to either would have silently given the
// two pages different ideas of a thin sample.

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
    const header = "Rank,City,Traced %,Units moved,Not accounted for,Urgent,vs last period\n";
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

  // The city the trophy actually belongs to: best-ranked with a real sample.
  const medalCity = useMemo(
    () => rows.find((r) => r.accuracy !== null && r.movements >= MIN_MOVEMENTS)?.city ?? null,
    [rows]
  );
  const thinRows = rows.filter(
    (r) => r.accuracy !== null && r.movements < MIN_MOVEMENTS
  ).length;

  return (
    <div className="p-container-margin space-y-6">
      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="font-headline text-xl text-text-primary mb-1">
            City Leaderboard
          </h1>
          <p className="text-text-muted text-sm">
            Which city traces the most of what it moves. Score = units traced end to end ÷ units moved. Days a warehouse was shut are left out.
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
            <span className="kpi-label">Cleanest city</span>
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
            <span className="kpi-label">Units moved</span>
            <Icon name="inventory_2" size={22} className="text-accent" />
          </div>
          <div className="mt-4">
            <h3 className="kpi-value">{totalMovements.toLocaleString()}</h3>
            <p className="text-xs text-text-muted">In and out, all cities, working days only</p>
          </div>
        </div>

        <div className="kpi-tile kpi-tile--danger card-hover flex flex-col justify-between">
          <div className="flex items-start justify-between">
            <span className="kpi-label">Not accounted for</span>
            <Icon name="report" size={22} className="text-danger" />
          </div>
          <div className="mt-4">
            <h3 className="kpi-value text-danger">{totalReal.toLocaleString()}</h3>
            {/* clampPct, like every other percentage in the app. This one was
                printing the raw quotient — 1.7218543046357615% — beside a tile
                that rounds the same ratio to one decimal. */}
            <p className="text-xs text-text-muted">{pct(totalMovements ? clampPct((totalReal / totalMovements) * 100) : null)} of the {totalMovements.toLocaleString()} units moved</p>
          </div>
        </div>

        <div className="kpi-tile kpi-tile--accent card-hover flex flex-col justify-between overflow-hidden relative">
          <div className="relative z-10">
            <span className="kpi-label">Traced end to end</span>
            <h3 className="kpi-value mt-4">{pct(avgAccuracy)}</h3>
            <p className="text-xs text-text-muted">Weighted by units moved — not an average of the city scores</p>
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
              {loading ? "Loading…" : "No stock checks have run yet — run one to fill the scoreboard."}
            </p>
          </div>
        ) : (
          <>
            {/* Mobile: card list (below md) */}
            <div className="md:hidden divide-y divide-border">
              {rows.map((r) => {
                const trend = TREND_ICON[r.trend];
                return (
                  <div key={r.city} className={`p-4 ${r.city === medalCity ? "row-gold" : ""}`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        {r.city === medalCity ? (
                          <Icon name="workspace_premium" size={20} className="text-[#b9aa83] shrink-0" />
                        ) : (
                          <span className="font-headline text-base text-text-muted shrink-0">#{r.rank}</span>
                        )}
                        <span className="font-headline text-base text-text-primary truncate">{r.city}</span>
                        <Icon name={trend.icon} size={18} className={`shrink-0 ${trend.cls}`} />
                      </div>
                      <span className="font-bold text-text-primary shrink-0 tabular-nums">
                        {pct(r.accuracy)}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted mt-2">
                      <span className="tabular-nums">{r.movements.toLocaleString()} moves</span>
                      <span className={r.real > 0 ? "text-danger font-semibold" : ""}>{r.real} not traced</span>
                      <span>{r.high} urgent</span>
                      {r.accuracy !== null && r.movements < MIN_MOVEMENTS && (
                        <span className="badge badge-suppressed">Low sample</span>
                      )}
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
                    <th className="text-right">Traced %</th>
                    <th className="text-right">Units moved</th>
                    <th className="text-right">Not accounted for</th>
                    <th className="text-center">Urgent</th>
                    <th className="text-center">vs last period</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const trend = TREND_ICON[r.trend];
                    const noData = r.accuracy === null;
                    const thin = !noData && r.movements < MIN_MOVEMENTS;
                    return (
                      <tr key={r.city} className={r.city === medalCity ? "row-gold" : ""}>
                        <td className="text-center">
                          {r.city === medalCity ? (
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
                          {thin && (
                            <span
                              className="badge badge-suppressed ml-2"
                              title={`Under ${MIN_MOVEMENTS} movements — this percentage is not comparable with a full warehouse`}
                            >
                              Low sample
                            </span>
                          )}
                        </td>
                        <td
                          className={`text-right font-bold tabular-nums ${
                            thin ? "text-text-muted" : "text-text-primary"
                          }`}
                        >
                          {pct(r.accuracy)}
                        </td>
                        <td className="text-right tabular-nums">{r.movements.toLocaleString()}</td>
                        <td className="text-right tabular-nums">{r.real}</td>
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
        <div className="px-6 py-3 bg-surface-elevated border-t border-border flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-xs text-text-muted">
            {win ? `${win.label} • ranked by the share of units traced end to end` : "—"}
          </span>
          {thinRows > 0 && (
            <span className="text-xs text-text-muted">
              · {thinRows} cit{thinRows === 1 ? "y" : "ies"} under {MIN_MOVEMENTS} movements are
              marked low sample and can&rsquo;t take the medal — a near-perfect score on a
              handful of moves says more about the sample than the warehouse.
            </span>
          )}
        </div>
      </section>
    </div>
  );
}
