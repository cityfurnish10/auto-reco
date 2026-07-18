"use client";

// Manager dashboard — real, city-scoped reconciliation data. The manager only
// ever sees their own city (enforced by RLS on the API; the city filter here
// is belt-and-suspenders). Managers close variances with a reason (→ PATCH).

import { useEffect, useMemo, useState } from "react";
import type { SessionUser } from "@/lib/demo-auth";
import type { City } from "@/lib/sample-data";
import type { Bucket, Priority, VarianceStatus } from "@/lib/db/schema";
import CloseVarianceModal, { type ClosureReason } from "./close-variance-modal";
import { SourceBadge } from "@/components/source-badge";
import { Icon } from "@/components/icon";
import {
  useStats,
  useVariances,
  patchVariance,
  type VarianceFilters,
} from "@/lib/hooks/use-dashboard-data";

const PRIORITY_BADGE: Record<Priority, string> = {
  High: "badge badge-high",
  Medium: "badge badge-medium",
  Info: "badge badge-done",
};
const STATUS_BADGE: Record<VarianceStatus, string> = {
  open: "badge badge-medium",
  in_progress: "badge badge-suppressed",
  pending_approval: "badge badge-info",
  closed: "badge badge-done",
};

const STATUS_LABEL: Record<VarianceStatus, string> = {
  open: "open",
  in_progress: "in progress",
  pending_approval: "pending approval",
  closed: "closed",
};

const PAGE_SIZE = 25;

export default function ManagerDashboard({ user }: { user: SessionUser }) {
  const city = user.city as City;
  const [bucket, setBucket] = useState<Bucket | "ALL">("REAL");
  const [priority, setPriority] = useState<Priority | "ALL">("ALL");
  const [statusF, setStatusF] = useState<VarianceStatus | "ALL">("open");
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [dateF, setDateF] = useState(""); // "" = latest run
  const [page, setPage] = useState(1);
  const [submitting, setSubmitting] = useState<{ id: string; product: string; barcode: string } | null>(null);

  // Debounce the search box; a search finds across all buckets/statuses.
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(searchInput.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  const { stats, loading: statsLoading, refetch: refetchStats } = useStats(dateF || undefined);
  const cityAgg = useMemo(
    () => stats?.byCity.find((c) => c.city === city) ?? null,
    [stats, city]
  );

  const filters: VarianceFilters = useMemo(
    () => ({
      city,
      // While searching, span every bucket/priority/status/date so a targeted
      // barcode/ticket/SO lookup always surfaces the record.
      bucket: q ? "ALL" : bucket,
      priority: q ? "ALL" : priority,
      status: q ? "ALL" : statusF,
      date: q ? undefined : dateF || undefined,
      q: q || undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
    [city, bucket, priority, statusF, dateF, q, page]
  );
  const { rows, total, totalPages, loading, error, refetch } = useVariances(filters);

  // A manual "Run Reconciliation" (sidebar) dispatches this event — reload this
  // city's KPIs and variance table in place, keeping the current filters.
  useEffect(() => {
    const onDone = () => {
      refetch();
      refetchStats();
    };
    window.addEventListener("reconcile:complete", onDone);
    return () => window.removeEventListener("reconcile:complete", onDone);
  }, [refetch, refetchStats]);

  function resetPage<T>(setter: (v: T) => void) {
    return (v: T) => { setter(v); setPage(1); };
  }

  async function handleSubmitForApproval(reason: ClosureReason | "", note: string) {
    if (!submitting) return;
    try {
      await patchVariance(submitting.id, "submit", reason || undefined, note);
      setSubmitting(null);
      refetch();
      refetchStats();
    } catch (e) {
      alert(`Could not submit for approval: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Export the current (filtered) page of this city's variances as CSV.
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
    a.download = `variances_${city.toLowerCase()}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="p-container-margin space-y-6">
      <div>
        <h2 className="font-headline text-xl text-text-primary">Warehouse Operations Dashboard</h2>
        <p className="text-sm text-text-muted">
          Inventory reconciliation and variance resolution for {city}.
          {stats?.run && ` Run ${stats.run.business_date}${stats.usedFallbackRun ? " (latest available)" : ""}.`}
        </p>
      </div>

      {/* KPI grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="kpi-tile card-hover">
          <div className="p-2 bg-surface-elevated rounded-control text-accent w-fit mb-4"><Icon name="inventory_2" size={22} /></div>
          <p className="kpi-label">Total Variances</p>
          <h3 className="kpi-value mt-1">{statsLoading ? "…" : cityAgg?.total ?? 0}</h3>
        </div>
        <div className="kpi-tile kpi-tile--danger card-hover">
          <div className="p-2 bg-danger-soft text-danger rounded-control w-fit mb-4"><Icon name="warning" size={22} /></div>
          <p className="kpi-label">REAL — chase today</p>
          <h3 className="kpi-value text-danger mt-1">{statsLoading ? "…" : cityAgg?.real ?? 0}</h3>
        </div>
        <div className="kpi-tile card-hover">
          <div className="p-2 bg-accent-soft text-accent rounded-control w-fit mb-4"><Icon name="pending_actions" size={22} /></div>
          <p className="kpi-label">Open</p>
          <h3 className="kpi-value mt-1">{statsLoading ? "…" : cityAgg?.open ?? 0}</h3>
          {(cityAgg?.pendingApproval ?? 0) > 0 && (
            <p className="text-xs text-accent mt-1">{cityAgg?.pendingApproval} awaiting approval</p>
          )}
        </div>
        <div className="kpi-tile kpi-tile--success card-hover">
          <div className="p-2 bg-success-soft text-success rounded-control w-fit mb-4"><Icon name="task_alt" size={22} /></div>
          <p className="kpi-label">Closed</p>
          <h3 className="kpi-value mt-1">{statsLoading ? "…" : cityAgg?.closed ?? 0}</h3>
        </div>
      </div>

      {/* Count-only movements (PP boxes & consumables) — not variances */}
      <div className="card px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-1">
        <span className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
          Count-only movements · {city}
        </span>
        <span className="text-sm text-text-muted flex items-center gap-1.5">
          <Icon name="inventory_2" size={16} className="text-accent" /> PP-Box{" "}
          <b className="text-text-primary">{statsLoading ? "…" : cityAgg?.ppBox ?? 0}</b>
        </span>
        <span className="text-sm text-text-muted flex items-center gap-1.5">
          <Icon name="category" size={16} className="text-accent" /> Consumables{" "}
          <b className="text-text-primary">{statsLoading ? "…" : cityAgg?.consumable ?? 0}</b>
        </span>
        <span className="text-xs text-text-disabled">for this run — tracked as counts, not variances</span>
      </div>

      {/* Variance table */}
      <section className="card overflow-hidden flex flex-col">
        <div className="p-4 border-b border-border flex flex-col lg:flex-row justify-between lg:items-center gap-3 bg-surface-elevated">
          <div>
            <h3 className="font-headline text-lg text-text-primary">Variance Table — {city}</h3>
            <p className="text-xs text-text-muted mt-0.5">
              {loading ? "Loading…" : `${total} record${total === 1 ? "" : "s"}`}
              {q && <span className="text-accent"> · results for “{q}” (filters paused)</span>}
              {error && <span className="text-danger"> · {error}</span>}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-56">
              <Icon name="search" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search barcode / ticket / SO…"
                className="input-clean pl-9 w-full"
              />
              {searchInput && (
                <button
                  onClick={() => setSearchInput("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
                  title="Clear"
                >
                  <Icon name="close" size={16} />
                </button>
              )}
            </div>
            <input
              type="date"
              value={dateF}
              onChange={(e) => resetPage(setDateF)(e.target.value)}
              className="input-clean cursor-pointer"
              title="View a past reconciliation date (blank = latest)"
            />
            <select value={bucket} onChange={(e) => resetPage(setBucket)(e.target.value as Bucket | "ALL")} className="input-clean font-semibold cursor-pointer">
              <option value="ALL">All Buckets</option>
              <option value="REAL">REAL only</option>
              <option value="INFO">INFO only</option>
            </select>
            <select value={priority} onChange={(e) => resetPage(setPriority)(e.target.value as Priority | "ALL")} className="input-clean cursor-pointer">
              <option value="ALL">All Priority</option>
              <option value="High">High</option>
              <option value="Medium">Medium</option>
              <option value="Info">Info</option>
            </select>
            <select value={statusF} onChange={(e) => resetPage(setStatusF)(e.target.value as VarianceStatus | "ALL")} className="input-clean cursor-pointer">
              <option value="ALL">All Status</option>
              <option value="open">Open</option>
              <option value="in_progress">In Progress</option>
              <option value="pending_approval">Pending Approval</option>
              <option value="closed">Closed</option>
            </select>
            <button onClick={exportCsv} disabled={rows.length === 0} className="btn btn-primary disabled:opacity-40">
              <Icon name="download" size={18} />
              Export
            </button>
          </div>
        </div>

        {/* Mobile: card list (below md) */}
        <div className="md:hidden divide-y divide-border">
          {rows.map((v) => (
            <div key={v.id} className="p-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono font-semibold text-text-primary text-sm break-all">{v.barcode}</span>
                <span className={`${PRIORITY_BADGE[v.priority]} shrink-0`}>{v.priority}</span>
              </div>
              {v.product && <p className="text-sm text-text-secondary">{v.product}</p>}
              <p className="text-sm text-text-primary font-medium">{v.variance_name}</p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                <span>{v.business_date}</span>
                <SourceBadge source={v.variance_source} />
                {v.job_type && <span>{v.job_type}</span>}
                <span className={`${STATUS_BADGE[v.status]} uppercase`}>{STATUS_LABEL[v.status]}</span>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-muted">
                {v.so_number && <span>SO: {v.so_number}</span>}
                {v.ticket_id && <span>Ticket: {v.ticket_id}</span>}
              </div>
              {v.status === "closed" ? (
                <p className="text-xs text-success font-semibold mt-1">✓ Closed</p>
              ) : v.status === "pending_approval" ? (
                <p className="text-xs text-accent font-semibold mt-1">⏳ Awaiting admin approval</p>
              ) : (
                <>
                  {v.rejection_note && (
                    <p className="text-xs text-danger mt-1">Sent back: {v.rejection_note}</p>
                  )}
                  <button
                    onClick={() => setSubmitting({ id: v.id, product: v.product ?? "", barcode: v.barcode })}
                    className="btn btn-compact btn-primary w-full mt-1"
                  >
                    Submit for Approval
                  </button>
                </>
              )}
            </div>
          ))}
          {!loading && rows.length === 0 && (
            <div className="text-center py-10 text-text-muted flex flex-col items-center gap-2">
              <Icon name="search_off" size={32} className="text-text-disabled" />
              No variances match the selected filters.
            </div>
          )}
        </div>

        {/* Tablet/desktop: full table (md+) */}
        <div className="overflow-x-auto hidden md:block">
          <table className="table-clean">
            <thead>
              <tr>
                <th>Date</th>
                <th>Item Name</th>
                <th>Barcode</th>
                <th>Ticket ID</th>
                <th>Source</th>
                <th>Ops Type</th>
                <th>SO Number</th>
                <th>Variance</th>
                <th>Priority</th>
                <th>Status</th>
                <th className="text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id}>
                  <td className="whitespace-nowrap text-text-secondary">{v.business_date}</td>
                  <td className="max-w-[200px] truncate" title={v.product ?? ""}>{v.product ?? "—"}</td>
                  <td className="font-mono font-semibold text-text-primary">{v.barcode}</td>
                  <td className="text-text-secondary">{v.ticket_id ?? "—"}</td>
                  <td><SourceBadge source={v.variance_source} /></td>
                  <td className="text-text-secondary text-xs">{v.job_type ?? "—"}</td>
                  <td className="text-text-secondary">{v.so_number ?? "—"}</td>
                  <td className="max-w-[220px]" title={v.note ?? ""}>{v.variance_name}</td>
                  <td><span className={PRIORITY_BADGE[v.priority]}>{v.priority}</span></td>
                  <td>
                    <span className={`${STATUS_BADGE[v.status]} uppercase`} title={v.closure_reason ?? v.rejection_note ?? undefined}>
                      {STATUS_LABEL[v.status]}
                    </span>
                  </td>
                  <td className="text-right">
                    {v.status === "closed" ? (
                      <button disabled className="btn btn-compact btn-ghost opacity-50 cursor-not-allowed">Closed</button>
                    ) : v.status === "pending_approval" ? (
                      <span className="badge badge-info" title={v.submit_note ?? undefined}>Pending approval</span>
                    ) : (
                      <button
                        onClick={() => setSubmitting({ id: v.id, product: v.product ?? "", barcode: v.barcode })}
                        className="btn btn-compact btn-primary"
                      >
                        Submit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={11} className="text-center py-10 text-text-muted">
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

        <div className="p-3 border-t border-border flex justify-between items-center bg-surface-elevated px-4">
          <span className="text-xs text-text-muted">Page {page} of {Math.max(1, totalPages)} · {total} total</span>
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
      </section>

      {submitting && (
        <CloseVarianceModal
          itemName={submitting.product}
          itemCode={submitting.barcode}
          title="Submit for Approval"
          confirmLabel="Submit for Approval"
          reasonLabel="Reason for resolution"
          notePlaceholder="Add context for the admin reviewing this…"
          onConfirm={handleSubmitForApproval}
          onCancel={() => setSubmitting(null)}
        />
      )}
    </div>
  );
}
