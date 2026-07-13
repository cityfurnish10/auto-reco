"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useDemoStore } from "@/lib/demo-store";
import type { SessionUser } from "@/lib/demo-auth";
import {
  CITY_SUMMARIES,
  type Severity,
  type VarianceStatus,
  type VarianceRow,
  type ClosureReason,
} from "@/lib/sample-data";
import CloseVarianceModal from "./close-variance-modal";
import { Icon } from "@/components/icon";

const SEVERITY_BADGE: Record<Severity, string> = {
  HIGH: "badge badge-high",
  MEDIUM: "badge badge-medium",
  LOW: "badge badge-done",
};

const STATUS_BADGE: Record<VarianceStatus, string> = {
  OPEN: "badge badge-medium",
  CLOSED: "badge badge-done",
  DISPUTED: "badge badge-suppressed",
};

export default function ManagerDashboard({ user }: { user: SessionUser }) {
  const { variances, closeVariance } = useDemoStore();
  const [search, setSearch] = useState("");
  const [severityFilter, setSeverityFilter] = useState<"ALL" | Severity>("ALL");
  const [statusFilter, setStatusFilter] = useState<"ALL" | VarianceStatus>("ALL");
  const [closing, setClosing] = useState<VarianceRow | null>(null);

  const city = user.city!;
  const summary = CITY_SUMMARIES.find((c) => c.city === city);
  const topPerformer = CITY_SUMMARIES.find((c) => c.rank === 1);

  // City scoping: a manager only ever sees their own city's rows. With
  // Supabase this same guarantee moves to RLS at the DB level.
  const cityVariances = useMemo(
    () => variances.filter((v) => v.city === city),
    [variances, city]
  );

  const rows = useMemo(
    () =>
      cityVariances.filter(
        (v) =>
          (severityFilter === "ALL" || v.severity === severityFilter) &&
          (statusFilter === "ALL" || v.status === statusFilter) &&
          (search === "" ||
            v.itemName.toLowerCase().includes(search.toLowerCase()) ||
            v.itemCode.toLowerCase().includes(search.toLowerCase()))
      ),
    [cityVariances, severityFilter, statusFilter, search]
  );

  const open = cityVariances.filter((v) => v.status !== "CLOSED").length;
  const closedToday = cityVariances.filter(
    (v) =>
      v.status === "CLOSED" &&
      v.closedAt &&
      v.closedAt.slice(0, 10) === new Date().toISOString().slice(0, 10)
  ).length;

  function handleConfirmClose(reason: ClosureReason, note: string) {
    if (closing) {
      closeVariance(closing.id, reason, note, user.name);
      setClosing(null);
    }
  }

  return (
    <div className="p-container-margin space-y-6">
      {/* Header */}
      <div className="flex justify-between items-end">
        <div>
          <h2 className="font-headline text-xl text-text-primary">
            Warehouse Operations Dashboard
          </h2>
          <p className="text-sm text-text-muted">
            Monitoring inventory reconciliation and guard variance logs for{" "}
            {city}.
          </p>
        </div>
      </div>

      {/* Summary Bento Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="kpi-tile card-hover">
          <div className="flex justify-between items-start mb-4">
            <div className="p-2 bg-surface-elevated rounded-control text-accent">
              <Icon name="inventory_2" size={22} />
            </div>
          </div>
          <p className="kpi-label">Total Items Reconciled</p>
          <h3 className="kpi-value mt-1">
            {summary?.totalItems.toLocaleString()}
          </h3>
        </div>

        <div className="kpi-tile kpi-tile--danger card-hover">
          <div className="flex justify-between items-start mb-4">
            <div className="p-2 bg-danger-soft text-danger rounded-control">
              <Icon name="warning" size={22} />
            </div>
          </div>
          <p className="kpi-label">Open Variances</p>
          <h3 className="kpi-value text-danger mt-1">{open}</h3>
        </div>

        <div className="kpi-tile kpi-tile--success card-hover">
          <div className="flex justify-between items-start mb-4">
            <div className="p-2 bg-success-soft text-success rounded-control">
              <Icon name="task_alt" size={22} />
            </div>
          </div>
          <p className="kpi-label">Closed Today</p>
          <h3 className="kpi-value mt-1">{closedToday}</h3>
        </div>

        <div className="kpi-tile card-hover relative overflow-hidden">
          <div className="flex justify-between items-start mb-4">
            <div className="p-2 bg-accent-soft text-accent rounded-control">
              <Icon name="analytics" size={22} />
            </div>
          </div>
          <p className="kpi-label">Accuracy %</p>
          <h3 className="kpi-value mt-1">{summary?.accuracy}%</h3>
          <div
            className="absolute bottom-0 left-0 h-1 bg-accent"
            style={{ width: `${summary?.accuracy ?? 0}%` }}
          ></div>
        </div>

        <Link
          href="/leaderboard"
          className="card card-hover bg-accent text-white p-5 flex flex-col justify-between group"
        >
          <div className="flex justify-between items-start mb-4">
            <div className="p-2 bg-white/10 rounded-control">
              <Icon name="leaderboard" size={22} />
            </div>
            <Icon
              name="arrow_outward"
              size={18}
              className="opacity-0 group-hover:opacity-100 transition-opacity duration-150"
            />
          </div>
          <div>
            <p className="text-xs uppercase tracking-widest opacity-70">
              City Rank
            </p>
            <h3 className="text-2xl font-bold mt-1">
              #{summary?.rank}
              <span className="text-base font-semibold opacity-60">
                {" "}
                / {CITY_SUMMARIES.length}
              </span>
            </h3>
            <p className="text-xs opacity-60 mt-1">
              Top: {topPerformer?.city} ({topPerformer?.accuracy}%)
            </p>
          </div>
        </Link>
      </div>

      {/* Variance Table */}
      <section className="card overflow-hidden flex flex-col">
        <div className="p-4 border-b border-border flex flex-col lg:flex-row justify-between lg:items-center gap-3 bg-surface-elevated">
          <h3 className="font-headline text-lg text-text-primary">
            Variance Table — {city}
          </h3>
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Icon
                name="search"
                size={18}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
              />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search Item or Code..."
                className="input-clean pl-9 pr-8 w-64"
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 btn-icon w-6 h-6"
                  title="Clear search"
                >
                  <Icon name="close" size={16} />
                </button>
              )}
            </div>
            <select
              value={severityFilter}
              onChange={(e) =>
                setSeverityFilter(e.target.value as "ALL" | Severity)
              }
              className="input-clean cursor-pointer"
            >
              <option value="ALL">All Severity</option>
              <option value="HIGH">High</option>
              <option value="MEDIUM">Medium</option>
              <option value="LOW">Low</option>
            </select>
            <select
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as "ALL" | VarianceStatus)
              }
              className="input-clean cursor-pointer"
            >
              <option value="ALL">All Status</option>
              <option value="OPEN">Open</option>
              <option value="CLOSED">Closed</option>
              <option value="DISPUTED">Disputed</option>
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="table-clean">
            <thead>
              <tr>
                <th>Item Code</th>
                <th>Item Name</th>
                <th className="text-center">Odoo Qty</th>
                <th className="text-center">DT Qty</th>
                <th className="text-center">Sheet Qty</th>
                <th className="text-center">Guard Qty</th>
                <th className="text-center">Delta</th>
                <th>Severity</th>
                <th>Status</th>
                <th className="text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id}>
                  <td className="font-semibold">{v.itemCode}</td>
                  <td>{v.itemName}</td>
                  <td className="text-center">{v.odooQty}</td>
                  <td className="text-center">{v.dtQty}</td>
                  <td className="text-center">{v.sheetQty}</td>
                  <td className="text-center">{v.guardQty}</td>
                  <td
                    className={`text-center font-semibold ${
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
                          : undefined
                      }
                    >
                      {v.status}
                    </span>
                  </td>
                  <td className="text-right">
                    {v.status === "CLOSED" ? (
                      <button
                        disabled
                        className="btn btn-compact btn-ghost opacity-50 cursor-not-allowed"
                      >
                        Closed
                      </button>
                    ) : (
                      <button
                        onClick={() => setClosing(v)}
                        className="btn btn-compact btn-primary"
                      >
                        Close
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={10}
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

        <div className="p-3 border-t border-border flex justify-between items-center bg-surface-elevated">
          <span className="text-xs text-text-muted">
            Showing {rows.length} of {cityVariances.length} variances ({open}{" "}
            open)
          </span>
        </div>
      </section>

      {closing && (
        <CloseVarianceModal
          variance={closing}
          onConfirm={handleConfirmClose}
          onCancel={() => setClosing(null)}
        />
      )}
    </div>
  );
}
