"use client";

// A KPI tile's full drill-down, in place. Opening this leaves the page (and
// whatever filters the user had set on it) completely untouched — it owns its
// own query, filters and pagination, and hands each row on to the detail
// dialog.

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { Modal } from "@/components/modal";
import { SourceBadge } from "@/components/source-badge";
import { errText, useToast } from "@/components/toast";
import { RowCheckbox, SelectAllCheckbox } from "@/components/row-checkbox";
import { CardListSkeleton, TableBodySkeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { SortHeader, type SortState } from "@/components/sort-header";
import { useSelection } from "@/lib/hooks/use-selection";
import BulkActionBar from "./bulk-action-bar";
import VarianceDetailModal from "./variance-detail-modal";
import type { SessionUser } from "@/lib/demo-auth";
import type { Bucket, Priority, VarianceDB, VarianceStatus } from "@/lib/db/schema";
import type { City } from "@/lib/sample-data";
import {
  patchVariance,
  useVariances,
  useVarianceFacets,
} from "@/lib/hooks/use-dashboard-data";
import {
  PRIORITY_BADGE,
  STATUS_BADGE,
  STATUS_LABEL,
  ageLabel,
  formatTs,
  opsTypeLabel,
} from "@/lib/ui/variance-format";
import { shownBarcode } from "@/lib/ui/barcode-display";

const PAGE_SIZE = 50;

export interface ListModalRequest {
  bucket: Bucket | "ALL";
  status: VarianceStatus | "ALL";
  title: string;
}

export default function VarianceListModal({
  request,
  city,
  date,
  role,
  showCityColumn = true,
  onClose,
  onDirty,
}: {
  request: ListModalRequest | null;
  city: City | "ALL";
  date?: string;
  role: SessionUser["role"];
  showCityColumn?: boolean;
  onClose: () => void;
  onDirty: () => void;
}) {
  const [bucket, setBucket] = useState<Bucket | "ALL">("ALL");
  const [status, setStatus] = useState<VarianceStatus | "ALL">("ALL");
  const [priority, setPriority] = useState<Priority | "ALL">("ALL");
  const [opsType, setOpsType] = useState<string>("ALL");
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState>({ key: "date", dir: "desc" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Keeps the detail dialog painted even if a refetch drops the row from the
  // current page (e.g. resolving it while filtered to "open"). State, not a
  // ref, because it is read during render.
  const [snapshot, setSnapshot] = useState<VarianceDB | null>(null);
  // Actions here shouldn't refetch the page behind the overlay on every click;
  // the parent syncs once, on close.
  const dirty = useRef(false);
  const toast = useToast();

  // Seed from the tile that opened us, and reset per opening.
  /* eslint-disable react-hooks/set-state-in-effect -- seed on open */
  useEffect(() => {
    if (!request) return;
    setBucket(request.bucket);
    setStatus(request.status);
    setPriority("ALL");
    setOpsType("ALL");
    setSearchInput("");
    setQ("");
    setPage(1);
    setSort({ key: "date", dir: "desc" });
    setSelectedId(null);
    dirty.current = false;
  }, [request]);

  useEffect(() => {
    const t = setTimeout(() => {
      setQ(searchInput.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [searchInput]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const { rows, total, totalPages, businessDate, loading, refetch } = useVariances({
    city,
    date,
    // A free-text search spans every bucket/status/date, same rule as the page
    // table. Without allDates the API would scope to the latest run only.
    bucket: q ? "ALL" : bucket,
    priority: q ? "ALL" : priority,
    status: q ? "ALL" : status,
    jobType: q ? "ALL" : opsType,
    allDates: !!q,
    q: q || undefined,
    sort: sort.key,
    dir: sort.dir,
    page,
    pageSize: PAGE_SIZE,
  });

  // Ops-type options for this dialog's scope. `enabled` keeps it from firing
  // while the dialog is closed — it is mounted by the dashboards at all times.
  const { opsTypes } = useVarianceFacets({ city, date, enabled: !!request });

  const selected = rows.find((r) => r.id === selectedId) ?? snapshot;

  // Selection lives here, not in the parent — this dialog owns its own query,
  // so its selection must reset when the dialog reopens against a new tile.
  const visibleIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const sel = useSelection(visibleIds);
  const lastClicked = useRef<string | null>(null);
  const selectedPendingApproval = useMemo(
    () => rows.filter((r) => sel.has(r.id) && r.status === "pending_approval").length,
    [rows, sel]
  );

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

  function applySort(next: SortState) {
    setSort(next);
    setPage(1);
  }

  // Only offer "reset" when the user has narrowed things past what the tile
  // opened with — resetting to the tile's own filters is the useful action, not
  // resetting to everything.
  const narrowed =
    !!request &&
    (bucket !== request.bucket ||
      status !== request.status ||
      priority !== "ALL" ||
      opsType !== "ALL" ||
      !!q);

  function resetToTile() {
    if (!request) return;
    setBucket(request.bucket);
    setStatus(request.status);
    setPriority("ALL");
    setOpsType("ALL");
    setSearchInput("");
    setQ("");
    setPage(1);
    sel.clear();
  }

  // Acting on the last row of the last page would otherwise strand the dialog
  // on a page that no longer exists.
  /* eslint-disable react-hooks/set-state-in-effect -- clamp after a load */
  useEffect(() => {
    if (!loading && totalPages > 0 && page > totalPages) setPage(totalPages);
  }, [loading, totalPages, page]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Changing a filter redefines the working set, so a stale selection must not
  // survive into a bulk action.
  function changeFilter(fn: () => void) {
    fn();
    setPage(1);
    sel.clear();
  }

  function openDetail(row: VarianceDB) {
    // Don't hijack a click that was really a text selection.
    if (window.getSelection()?.isCollapsed === false) return;
    setSnapshot(row);
    setSelectedId(row.id);
  }

  function handleClose() {
    if (dirty.current) onDirty();
    onClose();
  }

  async function act(id: string, action: "approve" | "dispute", label: string) {
    setBusyId(id);
    try {
      await patchVariance(id, action);
      toast.success(`Variance ${label}d.`);
      dirty.current = true;
      refetch();
    } catch (e) {
      // A toast, not alert(): this dialog holds a focus trap.
      toast.error(`Could not ${label} this variance.`, { detail: errText(e) });
    } finally {
      setBusyId(null);
    }
  }

  const isAdmin = role === "ADMIN";
  // checkbox + item + barcode + [city] + ticket + source + ops type +
  // variance + priority + status + age + action
  const colCount = showCityColumn ? 12 : 11;

  const filters = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative flex-1 min-w-[200px]">
        <Icon
          name="search"
          size={16}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
        />
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search barcode / ticket / SO / product…"
          className="input-clean pl-9 w-full"
        />
      </div>
      <select
        value={bucket}
        onChange={(e) => changeFilter(() => setBucket(e.target.value as Bucket | "ALL"))}
        className="input-clean font-semibold cursor-pointer"
      >
        <option value="ALL">All buckets</option>
        <option value="REAL">Losses only</option>
        <option value="INFO">Audit only</option>
      </select>
      <select
        value={status}
        onChange={(e) => changeFilter(() => setStatus(e.target.value as VarianceStatus | "ALL"))}
        className="input-clean font-semibold cursor-pointer"
      >
        <option value="ALL">All statuses</option>
        <option value="open">Open</option>
        <option value="in_progress">In progress</option>
        <option value="pending_approval">Pending approval</option>
        <option value="closed">Closed</option>
      </select>
      <select
        value={priority}
        onChange={(e) => changeFilter(() => setPriority(e.target.value as Priority | "ALL"))}
        className="input-clean font-semibold cursor-pointer"
      >
        <option value="ALL">All priority</option>
        <option value="High">High</option>
        <option value="Medium">Medium</option>
        <option value="Info">Info</option>
      </select>
      <select
        value={opsType}
        onChange={(e) => changeFilter(() => setOpsType(e.target.value))}
        className="input-clean cursor-pointer max-w-[200px]"
        title="Filter to one ops type"
      >
        <option value="ALL">All ops types</option>
        {opsTypes.map((f) => (
          <option key={f.value} value={f.value}>
            {opsTypeLabel(f.value)} ({f.real})
          </option>
        ))}
      </select>
    </div>
  );

  const pager = (
    <div className="px-4 py-3 flex justify-between items-center">
      <span className="text-xs text-text-muted">
        {loading ? "Loading…" : `${total} record${total === 1 ? "" : "s"}`}
        {q && <span className="text-accent"> · results for “{q}”</span>}
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
  );

  // The bulk bar lives in the dialog's own footer rather than docked to the
  // viewport — a fixed bar would sit on top of the pager directly below it.
  const footer = (
    <>
      {sel.count > 0 && (
        <BulkActionBar
          ids={sel.ids}
          role={role}
          pendingApprovalCount={selectedPendingApproval}
          variant="inline"
          onClear={sel.clear}
          onDone={() => {
            dirty.current = true;
            refetch();
          }}
        />
      )}
      {pager}
    </>
  );

  const rowActions = (v: VarianceDB) => {
    if (!isAdmin || v.status === "closed") return null;
    if (v.status === "pending_approval") {
      return (
        <button
          onClick={(e) => {
            e.stopPropagation();
            act(v.id, "approve", "approve");
          }}
          disabled={busyId === v.id}
          className="btn btn-compact btn-primary disabled:opacity-40"
        >
          Approve
        </button>
      );
    }
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          openDetail(v);
        }}
        className="btn btn-compact btn-secondary"
      >
        Review
      </button>
    );
  };

  return (
    <>
      <Modal
        open={!!request}
        onClose={handleClose}
        level="base"
        size="xl"
        mobile="fullscreen"
        title={request?.title ?? "Variances"}
        subtitle={
          // Name the date the API actually applied rather than asserting
          // "latest run" — with a search active the list deliberately spans
          // every date, and saying otherwise would be wrong.
          [
            q
              ? "All dates"
              : businessDate
                ? `Business date ${businessDate}${date ? "" : " · latest run"}`
                : null,
            city !== "ALL" ? String(city) : null,
          ]
            .filter(Boolean)
            .join(" · ") || "Variances"
        }
        headerExtra={filters}
        footer={footer}
        // Edge to edge: this footer is a bulk-action bar and a pager, both of
        // which are full-width components carrying their own padding. The
        // dialog's default inset would double it.
        footerClassName=""
        bodyClassName="p-0"
      >
        {/* Mobile: cards */}
        <div className="md:hidden divide-y divide-border">
          {rows.map((v) => (
            <div
              key={v.id}
              onClick={() => openDetail(v)}
              className={`p-4 space-y-1.5 cursor-pointer transition-colors ${
                sel.has(v.id) ? "bg-accent-soft" : "hover:bg-surface-elevated"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-3 min-w-0">
                  <span className="pt-0.5">
                    <RowCheckbox
                      checked={sel.has(v.id)}
                      onChange={() => onRowCheck(v.id, false)}
                      label={`Select ${shownBarcode(v)}`}
                    />
                  </span>
                  {/* A <div> can't take focus — this button is the keyboard route in. */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      openDetail(v);
                    }}
                    className="font-mono font-semibold text-text-primary text-sm break-all text-left hover:text-accent"
                  >
                    {shownBarcode(v)}
                  </button>
                </div>
                <span className={`${PRIORITY_BADGE[v.priority]} shrink-0`}>{v.priority}</span>
              </div>
              {v.product && <p className="text-sm text-text-secondary">{v.product}</p>}
              <p className="text-sm text-text-primary font-medium">{v.variance_name}</p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                {showCityColumn && <span>{v.city}</span>}
                <span>{v.business_date}</span>
                <SourceBadge source={v.variance_source} />
                <span className={`${STATUS_BADGE[v.status]} uppercase`}>
                  {STATUS_LABEL[v.status]}
                </span>
                <span title={formatTs(v.first_seen_at)}>{ageLabel(v.first_seen_at)} old</span>
              </div>
            </div>
          ))}
          {loading && rows.length === 0 && <CardListSkeleton />}
          {!loading && rows.length === 0 && (
            <EmptyState
              compact
              title={narrowed ? "No variances match these filters" : "Nothing in this category"}
              detail={narrowed ? undefined : "Everything here has been dealt with."}
              icon={narrowed ? "search_off" : "task_alt"}
              actionLabel={narrowed ? "Back to all in this category" : undefined}
              onAction={narrowed ? resetToTile : undefined}
            />
          )}
        </div>

        {/* Desktop: table */}
        <div className="hidden md:block">
          <table className="table-clean table-sticky-head">
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
                <SortHeader label="Item" sortKey="product" state={sort} onSort={applySort} />
                <SortHeader label="Barcode" sortKey="barcode" state={sort} onSort={applySort} />
                {showCityColumn && (
                  <SortHeader label="City" sortKey="city" state={sort} onSort={applySort} />
                )}
                <SortHeader label="Ticket" sortKey="ticket" state={sort} onSort={applySort} />
                <SortHeader label="Source" sortKey="source" state={sort} onSort={applySort} />
                <SortHeader label="Ops Type" sortKey="jobType" state={sort} onSort={applySort} />
                <SortHeader label="Variance" sortKey="variance" state={sort} onSort={applySort} />
                <SortHeader
                  label="Priority"
                  sortKey="priority"
                  state={sort}
                  onSort={applySort}
                  title="Sort by severity — High, Medium, Info"
                />
                <SortHeader label="Status" sortKey="status" state={sort} onSort={applySort} />
                <SortHeader
                  label="Age"
                  sortKey="age"
                  state={sort}
                  onSort={applySort}
                  title="Sort by how long this has been unresolved"
                />
                <th className="text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr
                  key={v.id}
                  onClick={() => openDetail(v)}
                  className={`cursor-pointer ${
                    sel.has(v.id)
                      ? "bg-accent-soft"
                      : selectedId === v.id
                        ? "bg-surface-elevated"
                        : ""
                  }`}
                >
                  <td onClick={(e) => e.stopPropagation()}>
                    <RowCheckbox
                      checked={sel.has(v.id)}
                      onChange={(shift) => onRowCheck(v.id, shift)}
                      label={`Select ${shownBarcode(v)}`}
                    />
                  </td>
                  <td className="max-w-[200px] truncate" title={v.product ?? ""}>
                    {v.product ?? "—"}
                  </td>
                  <td>
                    {/* A <tr> can't take focus — this button is the keyboard
                        route into the detail dialog. */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        openDetail(v);
                      }}
                      className="font-mono font-semibold text-text-primary hover:text-accent hover:underline"
                    >
                      {shownBarcode(v)}
                    </button>
                  </td>
                  {showCityColumn && <td>{v.city}</td>}
                  <td className="text-text-secondary">{v.ticket_id ?? "—"}</td>
                  <td>
                    <SourceBadge source={v.variance_source} />
                  </td>
                  <td className="text-text-secondary text-xs">{opsTypeLabel(v.job_type)}</td>
                  <td className="max-w-[240px]" title={v.note ?? ""}>
                    <span className="text-text-primary">{v.variance_name}</span>
                  </td>
                  <td>
                    <span className={PRIORITY_BADGE[v.priority]}>{v.priority}</span>
                  </td>
                  <td>
                    <span className={`${STATUS_BADGE[v.status]} uppercase`}>
                      {STATUS_LABEL[v.status]}
                    </span>
                  </td>
                  <td className="text-text-secondary whitespace-nowrap" title={formatTs(v.first_seen_at)}>
                    {ageLabel(v.first_seen_at)}
                  </td>
                  <td className="text-right">{rowActions(v)}</td>
                </tr>
              ))}
              {loading && rows.length === 0 && <TableBodySkeleton cols={colCount} />}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={colCount}>
                    <EmptyState
                      title={
                        narrowed ? "No variances match these filters" : "Nothing in this category"
                      }
                      detail={narrowed ? undefined : "Everything here has been dealt with."}
                      icon={narrowed ? "search_off" : "task_alt"}
                      actionLabel={narrowed ? "Back to all in this category" : undefined}
                      onAction={narrowed ? resetToTile : undefined}
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Modal>

      <VarianceDetailModal
        variance={selectedId ? selected ?? null : null}
        role={role}
        onClose={() => setSelectedId(null)}
        onChanged={() => {
          dirty.current = true;
          refetch();
        }}
      />

    </>
  );
}
