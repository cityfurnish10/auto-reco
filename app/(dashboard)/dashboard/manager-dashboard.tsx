"use client";

// Manager dashboard — real, city-scoped reconciliation data. The manager only
// ever sees their own city (enforced by RLS on the API; the city filter here
// is belt-and-suspenders). Managers close variances with a reason (→ PATCH).

import { useMemo, useState } from "react";
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
  closed: "badge badge-done",
};

const PAGE_SIZE = 25;

export default function ManagerDashboard({ user }: { user: SessionUser }) {
  const city = user.city as City;
  const [bucket, setBucket] = useState<Bucket | "ALL">("REAL");
  const [priority, setPriority] = useState<Priority | "ALL">("ALL");
  const [statusF, setStatusF] = useState<VarianceStatus | "ALL">("open");
  const [page, setPage] = useState(1);
  const [closing, setClosing] = useState<{ id: string; product: string; barcode: string } | null>(null);

  const { stats, loading: statsLoading, refetch: refetchStats } = useStats();
  const cityAgg = useMemo(
    () => stats?.byCity.find((c) => c.city === city) ?? null,
    [stats, city]
  );

  const filters: VarianceFilters = useMemo(
    () => ({ city, bucket, priority, status: statusF, page, pageSize: PAGE_SIZE }),
    [city, bucket, priority, statusF, page]
  );
  const { rows, total, totalPages, loading, error, refetch } = useVariances(filters);

  function resetPage<T>(setter: (v: T) => void) {
    return (v: T) => { setter(v); setPage(1); };
  }

  async function handleConfirmClose(reason: ClosureReason, note: string) {
    if (!closing) return;
    try {
      await patchVariance(closing.id, "close", reason, note);
      setClosing(null);
      refetch();
      refetchStats();
    } catch (e) {
      alert(`Could not close: ${e instanceof Error ? e.message : e}`);
    }
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
        </div>
        <div className="kpi-tile kpi-tile--success card-hover">
          <div className="p-2 bg-success-soft text-success rounded-control w-fit mb-4"><Icon name="task_alt" size={22} /></div>
          <p className="kpi-label">Closed</p>
          <h3 className="kpi-value mt-1">{statsLoading ? "…" : cityAgg?.closed ?? 0}</h3>
        </div>
      </div>

      {/* Variance table */}
      <section className="card overflow-hidden flex flex-col">
        <div className="p-4 border-b border-border flex flex-col lg:flex-row justify-between lg:items-center gap-3 bg-surface-elevated">
          <div>
            <h3 className="font-headline text-lg text-text-primary">Variance Table — {city}</h3>
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
              <option value="closed">Closed</option>
            </select>
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
                <span className={`${STATUS_BADGE[v.status]} uppercase`}>{v.status.replace("_", " ")}</span>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-muted">
                {v.so_number && <span>SO: {v.so_number}</span>}
                {v.ticket_id && <span>Ticket: {v.ticket_id}</span>}
              </div>
              {v.status !== "closed" ? (
                <button
                  onClick={() => setClosing({ id: v.id, product: v.product ?? "", barcode: v.barcode })}
                  className="btn btn-compact btn-primary w-full mt-1"
                >
                  Close variance
                </button>
              ) : (
                <p className="text-xs text-success font-semibold mt-1">✓ Closed</p>
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
                    <span className={`${STATUS_BADGE[v.status]} uppercase`} title={v.closure_reason ?? undefined}>
                      {v.status.replace("_", " ")}
                    </span>
                  </td>
                  <td className="text-right">
                    {v.status === "closed" ? (
                      <button disabled className="btn btn-compact btn-ghost opacity-50 cursor-not-allowed">Closed</button>
                    ) : (
                      <button
                        onClick={() => setClosing({ id: v.id, product: v.product ?? "", barcode: v.barcode })}
                        className="btn btn-compact btn-primary"
                      >
                        Close
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

      {closing && (
        <CloseVarianceModal
          itemName={closing.product}
          itemCode={closing.barcode}
          onConfirm={handleConfirmClose}
          onCancel={() => setClosing(null)}
        />
      )}
    </div>
  );
}
