"use client";

import { useMemo, useState } from "react";
import { useDemoStore } from "@/lib/demo-store";
import type { SessionUser } from "@/lib/demo-auth";
import {
  CITIES,
  CITY_SUMMARIES,
  OVERALL,
  type City,
  type Severity,
  type VarianceStatus,
} from "@/lib/sample-data";
import RunResultsPanel from "./run-results-panel";
import { Icon } from "@/components/icon";

type CityTab = "ALL" | City;

const SEVERITY_BADGE: Record<Severity, string> = {
  HIGH: "badge badge-high",
  MEDIUM: "badge badge-medium",
  LOW: "badge badge-done",
};

const STATUS_BADGE: Record<VarianceStatus, string> = {
  OPEN: "badge badge-medium",
  DISPUTED: "badge badge-suppressed",
  CLOSED: "badge badge-done",
};

const PAGE_SIZE = 10;

export default function AdminDashboard({ user }: { user: SessionUser }) {
  const { variances, disputeVariance, lastRun } = useDemoStore();
  const [cityTab, setCityTab] = useState<CityTab>("ALL");
  const [severityFilter, setSeverityFilter] = useState<"ALL" | Severity>("ALL");
  const [statusFilter, setStatusFilter] = useState<"ALL" | VarianceStatus>("ALL");
  const [page, setPage] = useState(1);

  const citySummaries = useMemo(
    () =>
      cityTab === "ALL"
        ? CITY_SUMMARIES
        : CITY_SUMMARIES.filter((c) => c.city === cityTab),
    [cityTab]
  );

  const filteredVariances = useMemo(
    () =>
      variances.filter(
        (v) =>
          (cityTab === "ALL" || v.city === cityTab) &&
          (severityFilter === "ALL" || v.severity === severityFilter) &&
          (statusFilter === "ALL" || v.status === statusFilter)
      ),
    [variances, cityTab, severityFilter, statusFilter]
  );

  const totalPages = Math.max(1, Math.ceil(filteredVariances.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filteredVariances.slice(
    (safePage - 1) * PAGE_SIZE,
    safePage * PAGE_SIZE
  );

  const stats = useMemo(() => {
    const rows = variances.filter(
      (v) => cityTab === "ALL" || v.city === cityTab
    );
    const open = rows.filter((v) => v.status !== "CLOSED").length;
    const high = rows.filter(
      (v) => v.severity === "HIGH" && v.status !== "CLOSED"
    ).length;
    const accuracy =
      cityTab === "ALL"
        ? OVERALL.avgAccuracy
        : CITY_SUMMARIES.find((c) => c.city === cityTab)?.accuracy ?? 0;
    return { total: rows.length, open, high, accuracy };
  }, [variances, cityTab]);

  function selectTab(tab: CityTab) {
    setCityTab(tab);
    setPage(1);
  }

  function exportCsv() {
    const header =
      "ID,Item Code,Item Name,City,Odoo Qty,DT Qty,Sheet Qty,Guard Qty,Delta,Severity,Status,Closure Reason,Closed By\n";
    const body = filteredVariances
      .map((v) =>
        [
          v.id,
          v.itemCode,
          `"${v.itemName}"`,
          v.city,
          v.odooQty,
          v.dtQty,
          v.sheetQty,
          v.guardQty,
          v.delta,
          v.severity,
          v.status,
          v.closureReason ?? "",
          v.closedBy ?? "",
        ].join(",")
      )
      .join("\n");
    const blob = new Blob([header + body], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `variances_${cityTab.toLowerCase()}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="p-container-margin space-y-8">
      {/* City Tabs */}
      <div className="border-b border-border flex gap-1 overflow-x-auto scrollbar-hide">
        {(["ALL", ...CITIES] as CityTab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => selectTab(tab)}
            className={
              cityTab === tab
                ? "px-4 py-2.5 text-sm font-semibold text-accent border-b-2 border-accent whitespace-nowrap transition-colors duration-150"
                : "px-4 py-2.5 text-sm text-text-secondary hover:text-accent whitespace-nowrap transition-colors duration-150"
            }
          >
            {tab === "ALL" ? "ALL CITIES" : tab}
          </button>
        ))}
      </div>

      {/* Latest reconciliation-engine run output (barcode-level) */}
      <RunResultsPanel cityFilter={cityTab} />

      {/* Summary Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="kpi-tile kpi-tile--accent card-hover flex flex-col justify-between">
          <span className="kpi-label">Total Variances Today</span>
          <div className="flex items-end justify-between mt-2">
            <span className="kpi-value">{stats.total}</span>
          </div>
          <span className="text-xs text-text-muted mt-1">
            {cityTab === "ALL"
              ? `Across all ${CITIES.length} connected cities`
              : `${cityTab} warehouse`}
          </span>
        </div>

        <div className="kpi-tile kpi-tile--danger card-hover flex flex-col justify-between">
          <span className="kpi-label">Open Variances</span>
          <div className="flex items-end justify-between mt-2">
            <span className="kpi-value">{stats.open}</span>
            {stats.high > 0 && (
              <span className="badge badge-high">{stats.high} High</span>
            )}
          </div>
          <span className="text-xs text-text-muted mt-1">
            Closed by city managers with a reason
          </span>
        </div>

        <div
          className={`kpi-tile card-hover flex flex-col justify-between ${
            stats.accuracy < 90 ? "kpi-tile--danger" : "kpi-tile--success"
          }`}
        >
          <span className="kpi-label">Accuracy %</span>
          <div className="flex items-end justify-between mt-2">
            <span
              className={`kpi-value ${stats.accuracy < 90 ? "text-danger" : ""}`}
            >
              {stats.accuracy}%
            </span>
          </div>
          <span className="text-xs text-text-muted mt-1">
            Benchmark target: 95.0%
          </span>
        </div>

        <div className="kpi-tile card-hover flex flex-col justify-between">
          <span className="kpi-label">Items Reconciled Today</span>
          <div className="flex items-end justify-between mt-2">
            <span className="kpi-value">
              {OVERALL.itemsReconciledToday.toLocaleString()}
            </span>
            <span className="text-text-muted font-semibold flex items-center gap-1 text-xs">
              <Icon name="schedule" size={16} />
              On-track
            </span>
          </div>
          <span className="text-xs text-text-muted mt-1">
            {lastRun
              ? `Last run: ${new Date(lastRun.at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}`
              : "Sample data — no run yet"}
          </span>
        </div>
      </div>

      {/* City-wise Breakdown */}
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <h3 className="font-headline text-lg text-text-primary">
            City-wise Variance Breakdown
          </h3>
          <span className="text-xs text-text-muted uppercase tracking-wider font-semibold">
            Ranked by accuracy
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
          {citySummaries.map((c) => {
            const liveOpen = variances.filter(
              (v) => v.city === c.city && v.status !== "CLOSED"
            ).length;
            return (
              <div
                key={c.city}
                className={`card card-hover p-4 flex flex-col gap-4 border-l-[3px] ${
                  c.accuracy < 90 ? "border-l-danger" : "border-l-border"
                }`}
              >
                <div className="flex justify-between items-start">
                  <div>
                    <h4 className="font-headline text-base text-text-primary flex items-center gap-2">
                      {c.city}
                      <span className="bg-surface-elevated text-text-secondary px-1.5 py-0.5 rounded text-xs font-bold">
                        #{c.rank}
                      </span>
                    </h4>
                    <span className="text-xs text-text-muted">
                      Station: {c.station}
                    </span>
                  </div>
                  <span
                    className={`font-bold text-lg ${
                      c.accuracy < 90 ? "text-danger" : "text-text-primary"
                    }`}
                  >
                    {c.accuracy}%
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-text-primary">
                    {liveOpen}
                  </span>
                  <span className="text-xs text-text-muted">
                    Open Variances
                  </span>
                </div>
                <div className="space-y-1">
                  <div className="flex h-2 w-full bg-surface-elevated overflow-hidden rounded-full">
                    <div
                      className="bg-danger"
                      style={{ width: `${c.highPct}%` }}
                      title="High Severity"
                    ></div>
                    <div
                      className="bg-status-warning"
                      style={{ width: `${c.medPct}%` }}
                      title="Medium Severity"
                    ></div>
                    <div
                      className="bg-success"
                      style={{ width: `${c.lowPct}%` }}
                      title="Low Severity"
                    ></div>
                  </div>
                  <div className="flex justify-between text-xs font-semibold text-text-muted uppercase">
                    <span>High</span>
                    <span>Med</span>
                    <span>Low</span>
                  </div>
                </div>
                <button
                  onClick={() => selectTab(c.city)}
                  className="btn btn-compact btn-secondary w-full"
                >
                  VIEW DETAIL
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Variance Table */}
      <div className="card overflow-hidden">
        <div className="p-4 border-b border-border bg-surface-elevated flex flex-col lg:flex-row justify-between lg:items-center gap-4">
          <div>
            <h3 className="font-headline text-lg text-text-primary">
              {cityTab === "ALL" ? "All Cities" : cityTab} Variance Table
            </h3>
            <p className="text-xs text-text-muted mt-0.5">
              Showing {filteredVariances.length} records (sample data)
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={severityFilter}
              onChange={(e) => {
                setSeverityFilter(e.target.value as "ALL" | Severity);
                setPage(1);
              }}
              className="input-clean font-semibold cursor-pointer"
            >
              <option value="ALL">All Severity</option>
              <option value="HIGH">High</option>
              <option value="MEDIUM">Medium</option>
              <option value="LOW">Low</option>
            </select>
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as "ALL" | VarianceStatus);
                setPage(1);
              }}
              className="input-clean font-semibold cursor-pointer"
            >
              <option value="ALL">All Status</option>
              <option value="OPEN">Open</option>
              <option value="DISPUTED">Disputed</option>
              <option value="CLOSED">Closed</option>
            </select>
            <button onClick={exportCsv} className="btn btn-primary">
              <Icon name="download" size={18} />
              Export
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="table-clean">
            <thead>
              <tr>
                <th>Item Code</th>
                <th>Item Name</th>
                <th>City</th>
                <th className="text-right">Odoo Qty</th>
                <th className="text-right">DT Qty</th>
                <th className="text-right">Sheet Qty</th>
                <th className="text-right">Guard Qty</th>
                <th className="text-right">Delta</th>
                <th>Severity</th>
                <th>Status</th>
                <th className="text-center">Action</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((v) => (
                <tr key={v.id}>
                  <td className="font-mono font-semibold text-text-primary">
                    {v.itemCode}
                  </td>
                  <td className="max-w-[220px] truncate">{v.itemName}</td>
                  <td>{v.city}</td>
                  <td className="text-right">{v.odooQty.toLocaleString()}</td>
                  <td className="text-right">{v.dtQty.toLocaleString()}</td>
                  <td className="text-right">{v.sheetQty.toLocaleString()}</td>
                  <td className="text-right">{v.guardQty.toLocaleString()}</td>
                  <td
                    className={`text-right font-semibold ${
                      v.delta < 0
                        ? "text-danger"
                        : v.delta > 0
                          ? "text-success"
                          : "text-text-muted"
                    }`}
                  >
                    {v.delta > 0 ? `+${v.delta}` : v.delta}
                  </td>
                  <td>
                    <span className={SEVERITY_BADGE[v.severity]}>
                      {v.severity}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`${STATUS_BADGE[v.status]} uppercase`}
                      title={
                        v.status === "CLOSED" && v.closureReason
                          ? `${v.closureReason}${v.closureNote ? ` — ${v.closureNote}` : ""} (by ${v.closedBy})`
                          : v.status === "DISPUTED"
                            ? v.closureNote
                            : undefined
                      }
                    >
                      {v.status}
                    </span>
                  </td>
                  <td className="text-center">
                    {v.status === "OPEN" ? (
                      <button
                        onClick={() => disputeVariance(v.id, user.name)}
                        title="Flag as disputed — escalate to city manager"
                        className="btn-icon row-action hover:text-danger"
                      >
                        <Icon name="flag" size={18} />
                      </button>
                    ) : (
                      <span
                        className="text-text-disabled inline-flex p-1"
                        title={
                          v.status === "CLOSED"
                            ? `Closed by ${v.closedBy ?? "manager"}`
                            : "Disputed"
                        }
                      >
                        <Icon
                          name={v.status === "CLOSED" ? "task_alt" : "flag"}
                          size={18}
                        />
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {pageRows.length === 0 && (
                <tr>
                  <td
                    colSpan={11}
                    className="text-center py-10 text-text-muted"
                  >
                    <div className="flex flex-col items-center gap-2">
                      <Icon name="search_off" size={32} className="text-text-disabled" />
                      No variances match the selected filters.
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="p-3 border-t border-border bg-surface-elevated flex justify-between items-center px-4">
          <span className="text-xs text-text-muted">
            Showing{" "}
            {filteredVariances.length === 0
              ? 0
              : (safePage - 1) * PAGE_SIZE + 1}{" "}
            to {Math.min(safePage * PAGE_SIZE, filteredVariances.length)} of{" "}
            {filteredVariances.length} variances
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={safePage <= 1}
              className="btn-icon border border-border disabled:opacity-40"
            >
              <Icon name="chevron_left" size={18} />
            </button>
            <span className="px-3 text-xs font-semibold text-text-secondary">
              {safePage} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={safePage >= totalPages}
              className="btn-icon border border-border disabled:opacity-40"
            >
              <Icon name="chevron_right" size={18} />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
