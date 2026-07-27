"use client";

// The Pending List — variances an admin or city manager parked for follow-up
// rather than finishing. A variance lands here by being resolved with the
// reason "Pending List"; it leaves by being resolved again with a real one.
//
// Visibility is not enforced here and must not be: the `variances_select` RLS
// policy already scopes reads to `city = auth_city()` for a manager and to
// everything for an admin, so a manager sees only their own city's list simply
// by loading the page. That is why this fetches through the cookie-bound client
// (via /api/variances) and never the service-role client.
//
// The query pins BOTH status=closed AND closure_reason. `dispute` also writes a
// closure_reason while a row is still in_progress, so filtering on the reason
// alone would show flagged rows that were never resolved at all.

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { SourceBadge } from "@/components/source-badge";
import { errText, useToast } from "@/components/toast";
import { RowCheckbox, SelectAllCheckbox } from "@/components/row-checkbox";
import { CardListSkeleton, TableBodySkeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { SortHeader, type SortState } from "@/components/sort-header";
import { useSelection } from "@/lib/hooks/use-selection";
import CloseVarianceModal from "../dashboard/close-variance-modal";
import { PENDING_LIST_REASON } from "../dashboard/close-variance-modal";
import VarianceDetailModal from "../dashboard/variance-detail-modal";
import type { SessionUser } from "@/lib/demo-auth";
import type { VarianceDB } from "@/lib/db/schema";
import type { City } from "@/lib/sample-data";
import { CITIES } from "@/lib/sample-data";
import {
  patchVariance,
  bulkPatchVariances,
  useVariances,
  useVarianceFacets,
  type VarianceFilters,
} from "@/lib/hooks/use-dashboard-data";
import {
  PRIORITY_BADGE,
  ageLabel,
  formatTs,
  opsTypeLabel,
  responsibleLabel,
} from "@/lib/ui/variance-format";

const PAGE_SIZE = 25;

export default function PendingListClient({ user }: { user: SessionUser }) {
  const toast = useToast();
  const isAdmin = user.role === "ADMIN";
  // A manager is pinned to their own city; RLS enforces it regardless, this
  // just keeps the request honest and lets the admin switch.
  const [cityTab, setCityTab] = useState<City | "ALL">(isAdmin ? "ALL" : (user.city as City));
  const [opsType, setOpsType] = useState<string>("ALL");
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortState>({ key: "updated", dir: "desc" });
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<VarianceDB | null>(null);
  const [resolving, setResolving] = useState<VarianceDB | null>(null);
  const [bulkResolving, setBulkResolving] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setQ(searchInput.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  const filters: VarianceFilters = useMemo(
    () => ({
      city: cityTab,
      // The pending list is a standing queue, not a single night's output —
      // an item parked three days ago is still pending today. So it spans
      // every business date rather than scoping to the latest run.
      allDates: true,
      status: "closed",
      closureReason: PENDING_LIST_REASON,
      jobType: q ? "ALL" : opsType,
      q: q || undefined,
      sort: sort.key,
      dir: sort.dir,
      page,
      pageSize: PAGE_SIZE,
    }),
    [cityTab, opsType, q, sort, page]
  );
  const { rows, total, totalPages, loading, error, refetch } = useVariances(filters);
  const { opsTypes } = useVarianceFacets({ city: cityTab });

  const visibleIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const sel = useSelection(visibleIds);
  const lastClicked = useRef<string | null>(null);

  function onRowCheck(id: string, shiftKey: boolean) {
    if (shiftKey && lastClicked.current && lastClicked.current !== id) {
      const a = visibleIds.indexOf(lastClicked.current);
      const b = visibleIds.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        sel.selectRange(visibleIds.slice(lo, hi + 1), !sel.has(id));
        lastClicked.current = id;
        return;
      }
    }
    sel.toggle(id);
    lastClicked.current = id;
  }

  /* eslint-disable react-hooks/set-state-in-effect -- clamp after a load */
  useEffect(() => {
    if (!loading && totalPages > 0 && page > totalPages) setPage(totalPages);
  }, [loading, totalPages, page]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function changeFilter(fn: () => void) {
    fn();
    setPage(1);
    sel.clear();
  }

  function openDetail(v: VarianceDB) {
    if (window.getSelection()?.isCollapsed === false) return;
    setDetail(v);
  }

  // Resolving OUT of the pending list — re-close with a real reason. Choosing
  // "Pending List" again would just leave it here, so that is rejected.
  async function handleResolve(reason: string, note: string) {
    if (!resolving) return;
    if (!reason || reason === PENDING_LIST_REASON) {
      toast.error("Pick a reason other than Pending List to take this off the list.");
      return;
    }
    try {
      await patchVariance(resolving.id, "close", reason, note);
      toast.success(`${resolving.barcode} resolved — off the pending list.`);
      setResolving(null);
      refetch();
    } catch (e) {
      toast.error("Could not resolve this variance.", { detail: errText(e) });
    }
  }

  async function handleBulkResolve(reason: string, note: string) {
    if (!reason || reason === PENDING_LIST_REASON) {
      toast.error("Pick a reason other than Pending List to take these off the list.");
      return;
    }
    const ids = sel.ids;
    try {
      const res = await bulkPatchVariances(ids, "close", reason, note || undefined);
      if (res.skipped > 0) {
        toast.info(`${res.updated} of ${res.requested} resolved.`, {
          detail: `${res.skipped} were skipped — outside your city or already changed.`,
        });
      } else {
        toast.success(`${res.updated} resolved — off the pending list.`);
      }
      setBulkResolving(false);
      sel.clear();
      refetch();
    } catch (e) {
      toast.error("Bulk resolve failed — nothing was changed.", { detail: errText(e) });
    }
  }

  function applySort(next: SortState) {
    setSort(next);
    setPage(1);
  }

  const filtersActive = opsType !== "ALL" || !!q || (isAdmin && cityTab !== "ALL");
  const colCount = isAdmin ? 11 : 10;

  return (
    <div className="p-container-margin space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-headline text-xl text-text-primary mb-1">Pending List</h1>
          <p className="text-sm text-text-muted">
            Variances parked for follow-up rather than finished.{" "}
            {isAdmin ? "All cities." : `${user.city} only.`} Resolve one with a real reason to
            take it off the list.
          </p>
        </div>
        <span className="badge badge-medium text-sm">
          {loading ? "…" : `${total} pending`}
        </span>
      </div>

      {/* City tabs — admin only; a manager has exactly one city. */}
      {isAdmin && (
        <div className="border-b border-border flex gap-1 overflow-x-auto scrollbar-hide">
          {(["ALL", ...CITIES] as (City | "ALL")[]).map((tab) => (
            <button
              key={tab}
              onClick={() => changeFilter(() => setCityTab(tab))}
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
      )}

      <div className="card overflow-hidden">
        <div className="p-4 border-b border-border bg-surface-elevated flex flex-col lg:flex-row justify-between lg:items-center gap-3">
          <p className="text-xs text-text-muted">
            {loading ? "Loading…" : `${total} item${total === 1 ? "" : "s"}`}
            <span> · across all business dates</span>
            {error && <span className="text-danger"> · {error}</span>}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-56">
              <Icon
                name="search"
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
              />
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search barcode / ticket / SO…"
                className="input-clean pl-9 w-full"
              />
            </div>
            <select
              value={opsType}
              onChange={(e) => changeFilter(() => setOpsType(e.target.value))}
              className="input-clean cursor-pointer max-w-[200px]"
              title="Filter to one ops type"
            >
              <option value="ALL">All Ops Types</option>
              {opsTypes.map((f) => (
                <option key={f.value} value={f.value}>
                  {opsTypeLabel(f.value)} ({f.count})
                </option>
              ))}
            </select>
            {sel.count > 0 && (
              <button onClick={() => setBulkResolving(true)} className="btn btn-primary">
                <Icon name="task_alt" size={18} />
                Resolve {sel.count}
              </button>
            )}
          </div>
        </div>

        {/* Mobile cards */}
        <div className="md:hidden divide-y divide-border">
          {loading && rows.length === 0 && <CardListSkeleton />}
          {rows.map((v) => (
            <div
              key={v.id}
              onClick={() => openDetail(v)}
              className={`p-4 space-y-2 cursor-pointer transition-colors ${
                sel.has(v.id) ? "bg-accent-soft" : "active:bg-surface-elevated"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-3 min-w-0">
                  <span className="pt-0.5">
                    <RowCheckbox
                      checked={sel.has(v.id)}
                      onChange={() => onRowCheck(v.id, false)}
                      label={`Select ${v.barcode}`}
                    />
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      openDetail(v);
                    }}
                    className="font-mono font-semibold text-text-primary text-sm break-all text-left hover:text-accent"
                  >
                    {v.barcode}
                  </button>
                </div>
                <span className={`${PRIORITY_BADGE[v.priority]} shrink-0`}>{v.priority}</span>
              </div>
              {v.product && <p className="text-sm text-text-secondary">{v.product}</p>}
              <p className="text-sm text-text-primary font-medium">{v.variance_name}</p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                {isAdmin && <span>{v.city}</span>}
                <span>{v.business_date}</span>
                <SourceBadge source={v.variance_source} />
                {v.job_type && <span>{opsTypeLabel(v.job_type)}</span>}
                <span title={formatTs(v.closed_at)}>parked {ageLabel(v.closed_at)} ago</span>
              </div>
              {v.closure_note && (
                <p className="text-xs text-text-muted">Note: {v.closure_note}</p>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setResolving(v);
                }}
                className="btn btn-compact btn-primary w-full mt-1"
              >
                Resolve
              </button>
            </div>
          ))}
          {!loading && rows.length === 0 && (
            <EmptyState
              compact
              icon={filtersActive ? "search_off" : "task_alt"}
              title={filtersActive ? "Nothing matches these filters" : "The pending list is empty"}
              detail={
                filtersActive
                  ? undefined
                  : "Nothing has been parked for follow-up. Resolve a variance with the reason “Pending List” to add one."
              }
            />
          )}
        </div>

        {/* Desktop table */}
        <div className="overflow-x-auto hidden md:block">
          <table className="table-clean">
            <thead>
              <tr>
                <th className="w-10">
                  <SelectAllCheckbox
                    checked={sel.allVisibleSelected}
                    indeterminate={sel.someVisibleSelected}
                    onChange={sel.toggleAllVisible}
                    label={`Select all ${rows.length} rows on this page`}
                  />
                </th>
                <SortHeader label="Date" sortKey="date" state={sort} onSort={applySort} />
                {isAdmin && (
                  <SortHeader label="City" sortKey="city" state={sort} onSort={applySort} />
                )}
                <SortHeader label="Item Name" sortKey="product" state={sort} onSort={applySort} />
                <SortHeader label="Barcode" sortKey="barcode" state={sort} onSort={applySort} />
                <SortHeader label="Ops Type" sortKey="jobType" state={sort} onSort={applySort} />
                <SortHeader label="Variance" sortKey="variance" state={sort} onSort={applySort} />
                <SortHeader label="Owner" sortKey="responsible" state={sort} onSort={applySort} />
                <th>Note</th>
                <SortHeader
                  label="Parked"
                  sortKey="updated"
                  state={sort}
                  onSort={applySort}
                  title="Sort by how long this has been on the list"
                />
                <th className="text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && <TableBodySkeleton cols={colCount} />}
              {rows.map((v) => (
                <tr
                  key={v.id}
                  onClick={() => openDetail(v)}
                  className={`cursor-pointer ${sel.has(v.id) ? "bg-accent-soft" : ""}`}
                >
                  <td onClick={(e) => e.stopPropagation()}>
                    <RowCheckbox
                      checked={sel.has(v.id)}
                      onChange={(shift) => onRowCheck(v.id, shift)}
                      label={`Select ${v.barcode}`}
                    />
                  </td>
                  <td className="whitespace-nowrap text-text-secondary">{v.business_date}</td>
                  {isAdmin && <td>{v.city}</td>}
                  <td className="max-w-[200px] truncate" title={v.product ?? ""}>
                    {v.product ?? "—"}
                  </td>
                  <td>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        openDetail(v);
                      }}
                      className="font-mono font-semibold text-text-primary hover:text-accent hover:underline"
                    >
                      {v.barcode}
                    </button>
                  </td>
                  <td className="text-text-secondary text-xs">{opsTypeLabel(v.job_type)}</td>
                  <td className="max-w-[220px]" title={v.note ?? ""}>
                    {v.variance_name}
                  </td>
                  <td className="text-text-secondary whitespace-nowrap">
                    {responsibleLabel(v.responsible)}
                  </td>
                  <td className="max-w-[200px] text-text-muted text-xs">
                    {v.closure_note || "—"}
                  </td>
                  <td
                    className="text-text-secondary whitespace-nowrap"
                    title={formatTs(v.closed_at)}
                  >
                    {ageLabel(v.closed_at)}
                  </td>
                  <td className="text-right">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setResolving(v);
                      }}
                      className="btn btn-compact btn-primary"
                    >
                      Resolve
                    </button>
                  </td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={colCount}>
                    <EmptyState
                      icon={filtersActive ? "search_off" : "task_alt"}
                      title={
                        filtersActive ? "Nothing matches these filters" : "The pending list is empty"
                      }
                      detail={
                        filtersActive
                          ? undefined
                          : "Nothing has been parked for follow-up. Resolve a variance with the reason “Pending List” to add one."
                      }
                    />
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
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="btn-icon border border-border disabled:opacity-40"
              aria-label="Previous page"
            >
              <Icon name="chevron_left" size={18} />
            </button>
            <span className="px-3 text-xs font-semibold text-text-secondary">
              {page} / {Math.max(1, totalPages)}
            </span>
            <button
              onClick={() => setPage((p) => (totalPages ? Math.min(totalPages, p + 1) : p))}
              disabled={page >= totalPages}
              className="btn-icon border border-border disabled:opacity-40"
              aria-label="Next page"
            >
              <Icon name="chevron_right" size={18} />
            </button>
          </div>
        </div>
      </div>

      {resolving && (
        <CloseVarianceModal
          itemName={resolving.product ?? ""}
          itemCode={resolving.barcode}
          title="Resolve from Pending List"
          confirmLabel="Resolve & Close"
          reasonLabel="How was this actually resolved?"
          notePlaceholder="What was found, and what was done about it…"
          onConfirm={handleResolve}
          onCancel={() => setResolving(null)}
        />
      )}

      {bulkResolving && (
        <CloseVarianceModal
          itemName={`${sel.count} pending item${sel.count === 1 ? "" : "s"}`}
          itemCode="bulk"
          title={`Resolve ${sel.count} from Pending List`}
          confirmLabel={`Resolve ${sel.count}`}
          reasonLabel="How were these resolved?"
          notePlaceholder="Recorded on every item in this batch…"
          onConfirm={handleBulkResolve}
          onCancel={() => setBulkResolving(false)}
        />
      )}

      <VarianceDetailModal
        variance={detail}
        role={user.role}
        onClose={() => setDetail(null)}
        onChanged={refetch}
      />
    </div>
  );
}
