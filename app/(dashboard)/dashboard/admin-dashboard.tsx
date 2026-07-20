"use client";

// Admin dashboard — real reconciliation data from the RLS-scoped API routes
// (/api/stats/summary + /api/variances). Columns match the DB variances table:
// Date, City, Item Name, Barcode, Ticket ID, Source, Ops Type, SO Number,
// Variance, Priority, Status. Defaults to the REAL + open "chase list".

import { useEffect, useMemo, useState } from "react";
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
import CloseVarianceModal from "./close-variance-modal";
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
  pending_approval: "badge badge-info",
  closed: "badge badge-done",
};

const STATUS_LABEL: Record<VarianceStatus, string> = {
  open: "open",
  in_progress: "in progress",
  pending_approval: "pending approval",
  closed: "closed",
};

const SOURCES: VarianceSource[] = ["Odoo", "DT", "Sheet", "Physical", "Cross"];
const PAGE_SIZE = 25;

export default function AdminDashboard({ user }: { user: SessionUser }) {
  const [cityTab, setCityTab] = useState<CityTab>("ALL");
  const [bucket, setBucket] = useState<Bucket | "ALL">("REAL");
  const [source, setSource] = useState<VarianceSource | "ALL">("ALL");
  const [priority, setPriority] = useState<Priority | "ALL">("ALL");
  const [status, setStatus] = useState<VarianceStatus | "ALL">("open");
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [dateF, setDateF] = useState(""); // "" = latest run
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<{ id: string; product: string; barcode: string } | null>(null);
  const [runningDate, setRunningDate] = useState(false);
  const [runToast, setRunToast] = useState<string | null>(null);

  // Debounce the search box; a search finds across all buckets/statuses.
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(searchInput.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  // The notification bell links here with ?status=pending_approval — seed the
  // status filter from the URL so a click lands on the approval queue.
  /* eslint-disable react-hooks/set-state-in-effect -- one-time URL seed on mount */
  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get("status");
    if (s === "pending_approval") setStatus("pending_approval");
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const { stats, loading: statsLoading, refetch: refetchStats } = useStats(dateF || undefined);

  const filters: VarianceFilters = useMemo(
    () => ({
      city: cityTab,
      // While searching, span every bucket/source/priority/status/date so a
      // targeted barcode/ticket/SO lookup always surfaces the record.
      bucket: q ? "ALL" : bucket,
      source: q ? "ALL" : source,
      priority: q ? "ALL" : priority,
      status: q ? "ALL" : status,
      date: q ? undefined : dateF || undefined,
      q: q || undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
    [cityTab, bucket, source, priority, status, dateF, q, page]
  );
  const { rows, total, totalPages, loading, error, refetch } = useVariances(filters);

  // A manual "Run Reconciliation" (sidebar) dispatches this event — reload the
  // KPIs and variance table in place, keeping the admin's current filters.
  useEffect(() => {
    const onDone = () => {
      refetch();
      refetchStats();
    };
    window.addEventListener("reconcile:complete", onDone);
    return () => window.removeEventListener("reconcile:complete", onDone);
  }, [refetch, refetchStats]);

  // A specific date is picked but there's no stored run for it (stats fell back
  // to the latest run, or none exists) → offer to reconcile that day now.
  const missingRunForDate =
    !!dateF &&
    !statsLoading &&
    (!stats?.run || stats.usedFallbackRun || stats.run.business_date !== dateF);

  async function runForDate() {
    if (!dateF || runningDate) return;
    if (
      !window.confirm(
        `Run reconciliation for ${dateF} now? It pulls all four sources (guard, sheet, DT, Odoo) and can take up to a minute.`
      )
    ) {
      return;
    }
    setRunningDate(true);
    setRunToast(null);
    try {
      const res = await fetch("/api/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ date: dateF }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
      const c = json.combined ?? {};
      setRunToast(
        `Run ${json.runDate} · ${json.status} — ${c.real_count ?? 0} REAL, ${c.info_count ?? 0} INFO, ${json.variancesUpserted ?? 0} variances.`
      );
      window.dispatchEvent(new CustomEvent("reconcile:complete"));
    } catch (e) {
      setRunToast(`Reconciliation failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunningDate(false);
      setTimeout(() => setRunToast(null), 8000);
    }
  }

  const agg = useMemo(() => {
    if (!stats) return null;
    return cityTab === "ALL"
      ? stats.overall
      : stats.byCity.find((c) => c.city === cityTab) ?? {
          city: cityTab, total: 0, open: 0, inProgress: 0, pendingApproval: 0, closed: 0,
          high: 0, medium: 0, info: 0, real: 0, infoBucket: 0, ppBox: 0, consumable: 0,
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

  // Approve a manager's submission → closes the variance (carries their reason).
  async function approve(id: string) {
    setBusyId(id);
    try {
      await patchVariance(id, "approve");
      refetch();
      refetchStats();
    } catch (e) {
      alert(`Could not approve: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusyId(null);
    }
  }

  // Reject a submission → back to open with a note the manager will see.
  async function handleReject(_reason: string, note: string) {
    if (!rejecting) return;
    try {
      await patchVariance(rejecting.id, "reject", undefined, note);
      setRejecting(null);
      refetch();
      refetchStats();
    } catch (e) {
      alert(`Could not reject: ${e instanceof Error ? e.message : e}`);
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
            {(agg?.pendingApproval ?? 0) > 0 && (
              <button
                onClick={() => resetPage(setStatus)("pending_approval")}
                className="text-accent font-semibold hover:underline"
              >
                {agg?.pendingApproval} pending approval
              </button>
            )}
            {(agg?.pendingApproval ?? 0) > 0 && " · "}
            {agg?.closed ?? 0} closed
          </span>
        </div>
      </div>

      {/* Count-only movements (PP boxes & consumables) — not variances */}
      <div className="card px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-1">
        <span className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
          Count-only movements{cityTab === "ALL" ? "" : ` · ${cityTab}`}
        </span>
        <span className="text-sm text-text-muted flex items-center gap-1.5">
          <Icon name="inventory_2" size={16} className="text-accent" /> PP-Box{" "}
          <b className="text-text-primary">{statsLoading ? "…" : agg?.ppBox ?? 0}</b>
        </span>
        <span className="text-sm text-text-muted flex items-center gap-1.5">
          <Icon name="category" size={16} className="text-accent" /> Consumables{" "}
          <b className="text-text-primary">{statsLoading ? "…" : agg?.consumable ?? 0}</b>
        </span>
        <span className="text-xs text-text-disabled">for this run — tracked as counts, not variances</span>
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
                <div className="text-xs text-text-disabled">
                  PP-Box {c.ppBox} · Consumable {c.consumable}
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
            {missingRunForDate && (
              <button
                onClick={runForDate}
                disabled={runningDate}
                title={`No reconciliation stored for ${dateF} — run it now`}
                className="btn btn-secondary disabled:opacity-50 whitespace-nowrap"
              >
                <Icon name={runningDate ? "progress_activity" : "sync_alt"} size={18} className={runningDate ? "animate-spin" : ""} />
                {runningDate ? "Running…" : `Run for ${dateF}`}
              </button>
            )}
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
                <span>{v.city}</span>
                <SourceBadge source={v.variance_source} />
                {v.job_type && <span>{v.job_type}</span>}
                <span className={`${STATUS_BADGE[v.status]} uppercase`}>{STATUS_LABEL[v.status]}</span>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-muted">
                {v.so_number && <span>SO: {v.so_number}</span>}
                {v.ticket_id && <span>Ticket: {v.ticket_id}</span>}
              </div>
              {v.status === "pending_approval" && (v.submit_reason || v.submit_note) && (
                <p className="text-xs text-text-muted mt-1">
                  <b>Submitted:</b> {[v.submit_reason, v.submit_note].filter(Boolean).join(" — ")}
                </p>
              )}
              {v.status === "pending_approval" ? (
                <div className="flex gap-2 mt-1">
                  <button
                    onClick={() => approve(v.id)}
                    disabled={busyId === v.id}
                    className="btn btn-compact btn-primary flex-1 disabled:opacity-40"
                  >
                    <Icon name="check_circle" size={16} /> Approve
                  </button>
                  <button
                    onClick={() => setRejecting({ id: v.id, product: v.product ?? "", barcode: v.barcode })}
                    disabled={busyId === v.id}
                    className="btn btn-compact btn-secondary flex-1 disabled:opacity-40"
                  >
                    <Icon name="close" size={16} /> Reject
                  </button>
                </div>
              ) : v.status === "open" ? (
                <button
                  onClick={() => dispute(v.id)}
                  disabled={busyId === v.id}
                  className="btn btn-compact btn-secondary w-full mt-1 disabled:opacity-40"
                >
                  <Icon name="flag" size={16} />
                  Dispute
                </button>
              ) : null}
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
                    <span
                      className={`${STATUS_BADGE[v.status]} uppercase`}
                      title={
                        v.status === "pending_approval"
                          ? [v.submit_reason, v.submit_note].filter(Boolean).join(" — ") || undefined
                          : v.closure_reason ?? undefined
                      }
                    >
                      {STATUS_LABEL[v.status]}
                    </span>
                  </td>
                  <td className="text-center">
                    {v.status === "pending_approval" ? (
                      <div className="inline-flex items-center gap-1">
                        <button
                          onClick={() => approve(v.id)}
                          disabled={busyId === v.id}
                          title="Approve — closes this variance"
                          className="btn-icon hover:text-success disabled:opacity-40"
                        >
                          <Icon name="check_circle" size={18} />
                        </button>
                        <button
                          onClick={() => setRejecting({ id: v.id, product: v.product ?? "", barcode: v.barcode })}
                          disabled={busyId === v.id}
                          title="Reject — send back to the manager"
                          className="btn-icon hover:text-danger disabled:opacity-40"
                        >
                          <Icon name="close" size={18} />
                        </button>
                      </div>
                    ) : v.status === "open" ? (
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
      {rejecting && (
        <CloseVarianceModal
          itemName={rejecting.product}
          itemCode={rejecting.barcode}
          title="Reject Submission"
          confirmLabel="Reject & send back"
          showReason={false}
          notePlaceholder="Explain why this is being sent back to the manager…"
          onConfirm={handleReject}
          onCancel={() => setRejecting(null)}
        />
      )}

      {runToast && (
        <div className="fixed inset-x-4 bottom-4 md:inset-x-auto md:right-8 md:bottom-8 card bg-accent text-white px-6 py-4 flex items-center gap-4 z-[70] shadow-card-hover">
          <div className="w-8 h-8 bg-success-soft text-success rounded-full flex items-center justify-center shrink-0">
            <Icon name="sync_alt" size={18} />
          </div>
          <p className="text-sm">{runToast}</p>
          <button onClick={() => setRunToast(null)} className="btn-icon text-white/60! hover:text-white! ml-2">
            <Icon name="close" size={18} />
          </button>
        </div>
      )}

      {/* user prop reserved for future per-admin audit; referenced to satisfy lint */}
      <span className="hidden">{user.email}</span>
    </section>
  );
}
