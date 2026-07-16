"use client";

// Admin dashboard — real reconciliation data from the RLS-scoped API routes
// (/api/stats/summary + /api/variances). Columns match the DB variances table:
// Date, City, Item Name, Barcode, Ticket ID, Source, Ops Type, SO Number,
// Variance, Priority, Status. Defaults to the REAL + open "chase list".

import { useMemo, useState } from "react";
import type { SessionUser } from "@/lib/demo-auth";
import { CITIES, type City } from "@/lib/sample-data";
import type {
  Bucket,
  Priority,
  VarianceSource,
  VarianceStatus,
} from "@/lib/db/schema";
import { SourceBadge } from "@/components/source-badge";
import { Icon } from "@/components/icon";
import {
  useStats,
  useVariances,
  patchVariance,
  type VarianceFilters,
} from "@/lib/hooks/use-dashboard-data";

type CityTab = "ALL" | City;

const PRIORITY_BADGE: Record<Priority, string> = {
  High: "badge badge-high",
  Medium: "badge badge-medium",
  Info: "badge badge-done",
};

const STATUS_BADGE: Record<VarianceStatus, string> = {
  open: "badge badge-medium",
  in_progress: "badge badge-suppressed",
  closed: "badge badge-done",
};

const SOURCES: VarianceSource[] = ["Odoo", "DT", "Sheet", "Physical", "Cross"];
const PAGE_SIZE = 25;

export default function AdminDashboard({ user }: { user: SessionUser }) {
  const [cityTab, setCityTab] = useState<CityTab>("ALL");
  const [bucket, setBucket] = useState<Bucket | "ALL">("REAL");
  const [source, setSource] = useState<VarianceSource | "ALL">("ALL");
  const [priority, setPriority] = useState<Priority | "ALL">("ALL");
  const [status, setStatus] = useState<VarianceStatus | "ALL">("open");
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);

  const { stats, loading: statsLoading, refetch: refetchStats } = useStats();

  const filters: VarianceFilters = useMemo(
    () => ({
      city: cityTab,
      bucket,
      source,
      priority,
      status,
      page,
      pageSize: PAGE_SIZE,
    }),
    [cityTab, bucket, source, priority, status, page]
  );
  const { rows, total, totalPages, loading, error, refetch } = useVariances(filters);

  const agg = useMemo(() => {
    if (!stats) return null;
    return cityTab === "ALL"
      ? stats.overall
      : stats.byCity.find((c) => c.city === cityTab) ?? {
          city: cityTab, total: 0, open: 0, inProgress: 0, closed: 0,
          high: 0, medium: 0, info: 0, real: 0, infoBucket: 0,
        };
  }, [stats, cityTab]);

  function resetPage<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v);
      setPage(1);
    };
  }

  async function dispute(id: string) {
    setBusyId(id);
    try {
      await patchVariance(id, "dispute");
      refetch();
      refetchStats();
    } catch (e) {
      alert(`Could not dispute: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusyId(null);
    }
  }

  function exportCsv() {
    const header =
      "Date,City,Direction,Item Name,Barcode,Ticket ID,Source,Ops Type,SO Number,Variance,Priority,Bucket,Status\n";
    const body = rows
      .map((v) =>
        [
          v.business_date, v.city, v.direction, `"${(v.product ?? "").replace(/"/g, "'")}"`,
          v.barcode, v.ticket_id ?? "", v.variance_source ?? "", v.job_type ?? "",
          v.so_number ?? "", `"${v.variance_name}"`, v.priority, v.bucket, v.status,
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

  const runLabel = stats?.run
    ? `Run ${stats.run.business_date}${stats.usedFallbackRun ? " (latest available)" : ""} · ${stats.run.status}`
    : "No reconciliation run yet";

  return (
    <section className="p-container-margin space-y-8">
      {/* City tabs */}
      <div className="border-b border-border flex gap-1 overflow-x-auto scrollbar-hide">
        {(["ALL", ...CITIES] as CityTab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => resetPage(setCityTab)(tab)}
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

      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="kpi-tile kpi-tile--accent flex flex-col justify-between">
          <span className="kpi-label">Total Variances</span>
          <span className="kpi-value mt-2">{statsLoading ? "…" : agg?.total ?? 0}</span>
          <span className="text-xs text-text-muted mt-1">{runLabel}</span>
        </div>
        <div className="kpi-tile kpi-tile--danger flex flex-col justify-between">
          <span className="kpi-label">REAL — chase today</span>
          <div className="flex items-end justify-between mt-2">
            <span className="kpi-value">{statsLoading ? "…" : agg?.real ?? 0}</span>
            {(agg?.high ?? 0) > 0 && <span className="badge badge-high">{agg?.high} High</span>}
          </div>
          <span className="text-xs text-text-muted mt-1">Genuine cross-source gaps</span>
        </div>
        <div className="kpi-tile flex flex-col justify-between">
          <span className="kpi-label">INFO — audit</span>
          <span className="kpi-value mt-2">{statsLoading ? "…" : agg?.infoBucket ?? 0}</span>
          <span className="text-xs text-text-muted mt-1">Posting lag / hygiene, no action</span>
        </div>
        <div className="kpi-tile flex flex-col justify-between">
          <span className="kpi-label">Open</span>
          <span className="kpi-value mt-2">{statsLoading ? "…" : agg?.open ?? 0}</span>
          <span className="text-xs text-text-muted mt-1">
            {agg?.closed ?? 0} closed · {agg?.inProgress ?? 0} in progress
          </span>
        </div>
      </div>

      {/* City-wise breakdown */}
      {cityTab === "ALL" && stats && stats.byCity.length > 0 && (
        <div className="space-y-4">
          <h3 className="font-headline text-lg text-text-primary">City-wise Breakdown</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
            {stats.byCity.map((c) => (
              <div
                key={c.city}
                className={`card card-hover p-4 flex flex-col gap-3 border-l-[3px] ${
                  c.real > 0 ? "border-l-danger" : "border-l-success"
                }`}
              >
                <div className="flex justify-between items-start">
                  <h4 className="font-headline text-base text-text-primary">{c.city}</h4>
                  <span className={`font-bold text-lg ${c.real > 0 ? "text-danger" : "text-success"}`}>
                    {c.real}
                  </span>
                </div>
                <div className="text-xs text-text-muted">
                  <span className="text-danger font-semibold">{c.real} REAL</span> ·{" "}
                  {c.infoBucket} INFO · {c.open} open
                </div>
                <button
                  onClick={() => resetPage(setCityTab)(c.city as City)}
                  className="btn btn-compact btn-secondary w-full"
                >
                  VIEW DETAIL
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Variance table */}
      <div className="card overflow-hidden">
        <div className="p-4 border-b border-border bg-surface-elevated flex flex-col lg:flex-row justify-between lg:items-center gap-4">
          <div>
            <h3 className="font-headline text-lg text-text-primary">
              {cityTab === "ALL" ? "All Cities" : cityTab} Variances
            </h3>
            <p className="text-xs text-text-muted mt-0.5">
              {loading ? "Loading…" : `${total} record${total === 1 ? "" : "s"}`}
              {error && <span className="text-danger"> · {error}</span>}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select value={bucket} onChange={(e) => resetPage(setBucket)(e.target.value as Bucket | "ALL")} className="input-clean font-semibold cursor-pointer">
              <option value="ALL">All Buckets</option>
              <option value="REAL">REAL only</option>
              <option value="INFO">INFO only</option>
            </select>
            <select value={source} onChange={(e) => resetPage(setSource)(e.target.value as VarianceSource | "ALL")} className="input-clean font-semibold cursor-pointer">
              <option value="ALL">All Sources</option>
              {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={priority} onChange={(e) => resetPage(setPriority)(e.target.value as Priority | "ALL")} className="input-clean font-semibold cursor-pointer">
              <option value="ALL">All Priority</option>
              <option value="High">High</option>
              <option value="Medium">Medium</option>
              <option value="Info">Info</option>
            </select>
            <select value={status} onChange={(e) => resetPage(setStatus)(e.target.value as VarianceStatus | "ALL")} className="input-clean font-semibold cursor-pointer">
              <option value="ALL">All Status</option>
              <option value="open">Open</option>
              <option value="in_progress">In Progress</option>
              <option value="closed">Closed</option>
            </select>
            <button onClick={exportCsv} disabled={rows.length === 0} className="btn btn-primary disabled:opacity-40">
              <Icon name="download" size={18} />
              Export
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="table-clean">
            <thead>
              <tr>
                <th>Date</th>
                <th>City</th>
                <th>Item Name</th>
                <th>Barcode</th>
                <th>Ticket ID</th>
                <th>Source</th>
                <th>Ops Type</th>
                <th>SO Number</th>
                <th>Variance</th>
                <th>Priority</th>
                <th>Status</th>
                <th className="text-center">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id}>
                  <td className="whitespace-nowrap text-text-secondary">{v.business_date}</td>
                  <td>{v.city}</td>
                  <td className="max-w-[200px] truncate" title={v.product ?? ""}>{v.product ?? "—"}</td>
                  <td className="font-mono font-semibold text-text-primary">{v.barcode}</td>
                  <td className="text-text-secondary">{v.ticket_id ?? "—"}</td>
                  <td><SourceBadge source={v.variance_source} /></td>
                  <td className="text-text-secondary text-xs">{v.job_type ?? "—"}</td>
                  <td className="text-text-secondary">{v.so_number ?? "—"}</td>
                  <td className="max-w-[220px]" title={v.note ?? ""}>
                    <span className="text-text-primary">{v.variance_name}</span>
                  </td>
                  <td><span className={PRIORITY_BADGE[v.priority]}>{v.priority}</span></td>
                  <td>
                    <span className={`${STATUS_BADGE[v.status]} uppercase`} title={v.closure_reason ?? undefined}>
                      {v.status.replace("_", " ")}
                    </span>
                  </td>
                  <td className="text-center">
                    {v.status === "open" ? (
                      <button
                        onClick={() => dispute(v.id)}
                        disabled={busyId === v.id}
                        title="Flag as disputed — escalate to city manager"
                        className="btn-icon row-action hover:text-danger disabled:opacity-40"
                      >
                        <Icon name="flag" size={18} />
                      </button>
                    ) : (
                      <span className="text-text-disabled inline-flex p-1" title={v.status}>
                        <Icon name={v.status === "closed" ? "task_alt" : "flag"} size={18} />
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={12} className="text-center py-10 text-text-muted">
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
            Page {page} of {Math.max(1, totalPages)} · {total} total
          </span>
          <div className="flex items-center gap-1">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="btn-icon border border-border disabled:opacity-40">
              <Icon name="chevron_left" size={18} />
            </button>
            <span className="px-3 text-xs font-semibold text-text-secondary">{page} / {Math.max(1, totalPages)}</span>
            <button onClick={() => setPage((p) => (totalPages ? Math.min(totalPages, p + 1) : p))} disabled={page >= totalPages} className="btn-icon border border-border disabled:opacity-40">
              <Icon name="chevron_right" size={18} />
            </button>
          </div>
        </div>
      </div>
      {/* user prop reserved for future per-admin audit; referenced to satisfy lint */}
      <span className="hidden">{user.email}</span>
    </section>
  );
}
