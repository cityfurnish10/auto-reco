"use client";

// Manager dashboard — real, city-scoped reconciliation data. The manager only
// ever sees their own city (enforced by RLS on the API; the city filter here
// is belt-and-suspenders). Managers close variances with a reason (→ PATCH).

import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionUser } from "@/lib/demo-auth";
import type { City } from "@/lib/sample-data";
import type { Bucket, Priority, VarianceDB, VarianceStatus } from "@/lib/db/schema";
import CloseVarianceModal, { type ClosureReason } from "./close-variance-modal";
import VarianceDetailModal from "./variance-detail-modal";
import VarianceListModal, { type ListModalRequest } from "./variance-list-modal";
import { isCityClosed } from "@/lib/engine/schedule";
import { addDays } from "@/lib/engine/dates";
import { closedCaption, queueCaption, rateCaption } from "@/lib/ui/stat-captions";
import {
  PRIORITY_BADGE,
  STATUS_BADGE,
  STATUS_LABEL,
  ageLabel,
  formatTs,
  opsTypeLabel,
  responsibleLabel,
} from "@/lib/ui/variance-format";
import { SortHeader, type SortState } from "@/components/sort-header";
import { RowCheckbox, SelectAllCheckbox } from "@/components/row-checkbox";
import { CardListSkeleton, TableBodySkeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { StaleRunBanner } from "./stale-run-banner";
import { useSelection } from "@/lib/hooks/use-selection";
import { useStickyState } from "@/lib/hooks/use-sticky-state";
import BulkActionBar from "./bulk-action-bar";
import { SourceBadge } from "@/components/source-badge";
import { Icon } from "@/components/icon";
import { errText, useToast } from "@/components/toast";
import { downloadCsv, varianceRowsToCsv } from "@/lib/ui/variance-csv";
import {
  useStats,
  useVariances,
  useVarianceFacets,
  patchVariance,
  fetchAllVariances,
  type VarianceFilters,
} from "@/lib/hooks/use-dashboard-data";

const PAGE_SIZE = 25;

export default function ManagerDashboard({ user }: { user: SessionUser }) {
  const toast = useToast();
  const city = user.city as City;
  const [bucket, setBucket] = useState<Bucket | "ALL">("REAL");
  const [priority, setPriority] = useState<Priority | "ALL">("ALL");
  const [statusF, setStatusF] = useState<VarianceStatus | "ALL" | "ACTIVE">("ACTIVE");
  const [varianceName, setVarianceName] = useState<string>("ALL");
  const [responsible, setResponsible] = useState<string>("ALL");
  const [opsType, setOpsType] = useState<string>("ALL");
  const [sort, setSort] = useState<SortState>({ key: "date", dir: "desc" });
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  // Sticky: survives navigating to another page and back, so a date the
  // user deliberately picked is not silently reset to the latest run.
  const [dateF, setDateF] = useStickyState("manager.businessDate", ""); // "" = latest run
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const [submitting, setSubmitting] = useState<{ id: string; product: string; barcode: string } | null>(null);
  const [listRequest, setListRequest] = useState<ListModalRequest | null>(null);
  const [detail, setDetail] = useState<VarianceDB | null>(null);

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
      variance: q ? "ALL" : varianceName,
      responsible: q ? "ALL" : responsible,
      jobType: q ? "ALL" : opsType,
      date: q ? undefined : dateF || undefined,
      // A search must find the barcode whatever night it landed on; everything
      // else stays scoped to a single run so the table agrees with the KPIs.
      allDates: !!q,
      q: q || undefined,
      sort: sort.key,
      dir: sort.dir,
      page,
      pageSize: PAGE_SIZE,
    }),
    [city, bucket, priority, statusF, varianceName, responsible, opsType, dateF, q, sort, page]
  );
  const { rows, total, totalPages, businessDate, sortDegraded, loading, error, refetch } =
    useVariances(filters);

  // Options come from this city's data, so the dropdowns only offer filters
  // that will return something.
  const { varianceNames, responsibles, opsTypes } = useVarianceFacets({
    city,
    date: dateF || undefined,
  });

  // Sorting is server-side, so a new sort must restart at page 1 — otherwise
  // you land on page 4 of a completely different order.
  function applySort(next: SortState) {
    setSort(next);
    setPage(1);
  }

  // Any filter is on = the empty state is recoverable, so offer the way out.
  const filtersActive =
    bucket !== "REAL" ||
    priority !== "ALL" ||
    statusF !== "ACTIVE" ||
    varianceName !== "ALL" ||
    responsible !== "ALL" ||
    opsType !== "ALL" ||
    !!dateF ||
    !!q;

  function clearFilters() {
    setBucket("REAL");
    setPriority("ALL");
    setStatusF("ACTIVE");
    setVarianceName("ALL");
    setResponsible("ALL");
    setOpsType("ALL");
    setDateF("");
    setSearchInput("");
    setPage(1);
    sel.clear();
  }

  // Submitting the last row on page 8 drops the total to 7 pages and strands
  // you on a page that no longer exists — "no matches" above "Page 8 of 7".
  /* eslint-disable react-hooks/set-state-in-effect -- clamp after a load */
  useEffect(() => {
    if (!loading && totalPages > 0 && page > totalPages) setPage(totalPages);
  }, [loading, totalPages, page]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Selection deliberately survives paging — see use-selection.ts.
  const visibleIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const sel = useSelection(visibleIds);
  const lastClicked = useRef<string | null>(null);

  // Shift-click selects the run between the two clicked rows, as in a file
  // manager. Falls back to a plain toggle when the anchor has been paged away.
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

  // Shared by the desktop row and the mobile card. Don't hijack a click that
  // was really the end of a text selection.
  function openDetail(v: VarianceDB) {
    if (window.getSelection()?.isCollapsed === false) return;
    setDetail(v);
  }

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
    return (v: T) => {
      setter(v);
      setPage(1);
      // A filter change redefines what's being looked at, so a selection made
      // under the old filters must not survive into a bulk action. Paging
      // deliberately does NOT clear it — see use-selection.ts.
      sel.clear();
    };
  }

  async function handleSubmitForApproval(reason: ClosureReason | "", note: string) {
    if (!submitting) return;
    try {
      await patchVariance(submitting.id, "submit", reason || undefined, note);
      toast.success(`${submitting.barcode} submitted — awaiting admin approval.`);
      setSubmitting(null);
      refetch();
      refetchStats();
    } catch (e) {
      toast.error("Could not submit for approval.", { detail: errText(e) });
    }
  }

  // Exports every row matching the current filters — not the page on screen.
  async function exportCsv() {
    if (exporting) return;
    setExporting(true);
    try {
      // Pin the resolved date so every page of the export describes the same
      // run — otherwise the server re-resolves "latest" per request and a run
      // landing mid-export would splice two days together.
      const { rows: all, truncated } = await fetchAllVariances({
        ...filters,
        date: filters.date ?? businessDate ?? undefined,
      });
      downloadCsv(
        `variances_${city.toLowerCase()}_${businessDate ?? "all-dates"}.csv`,
        varianceRowsToCsv(all)
      );
      if (truncated) {
        toast.info(`Exported the first ${all.length} rows.`, {
          detail: "That's the export cap — narrow by status or date to get the rest.",
        });
      } else {
        toast.success(`Exported ${all.length} row${all.length === 1 ? "" : "s"}.`);
      }
    } catch (e) {
      toast.error("Export failed.", { detail: errText(e) });
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="p-container-margin space-y-6">
      {/* The business-date picker sits in the page header, not the table
          toolbar: the same `dateF` drives the KPI tiles and the facet counts as
          well as the table, so scoping it visually to the table understated
          what it actually controls. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-headline text-xl text-text-primary">{city} daily stock check</h2>
          <p className="text-sm text-text-muted">
            {cityAgg ? rateCaption(cityAgg) : ""}
            {stats?.run && ` Run ${stats.run.business_date}.`}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <label htmlFor="business-date" className="text-xs text-text-muted whitespace-nowrap hidden sm:inline">
            Business date
          </label>
          <input
            id="business-date"
            type="date"
            value={dateF}
            /* resetPage, not a bare setDateF — it also clears the row selection,
               so a selection made under one date can't reach a bulk action on
               another. */
            onChange={(e) => resetPage(setDateF)(e.target.value)}
            className="input-clean cursor-pointer"
            title="View a past reconciliation date (blank = the latest run)"
          />
          {dateF && (
            <button
              onClick={() => resetPage(setDateF)("")}
              className="btn btn-compact btn-ghost"
              title="Back to the latest run"
            >
              Latest
            </button>
          )}
        </div>
      </div>

      {/* Not a parenthetical: a fallback means every figure below describes a
          different day than the one asked for. */}
      {stats?.usedFallbackRun && stats.run && (
        <StaleRunBanner
          showingDate={stats.run.business_date}
          requestedDate={dateF || undefined}
          onClear={dateF ? () => resetPage(setDateF)("") : undefined}
        />
      )}

      {/* Weekly-off notice on the off date itself; on the day BEFORE, the note
          is about the register schedule instead — the book is handed over after
          the holiday, so this board completes a day later than usual. */}
      {stats?.run && (isCityClosed(city, stats.run.business_date, stats.calendar) ||
        (!isCityClosed(city, stats.run.business_date, stats.calendar) &&
          isCityClosed(city, addDays(stats.run.business_date, 1), stats.calendar))) && (
        <div className="card p-4 flex items-center gap-3 border-l-[3px] border-l-border">
          <Icon name="event_busy" size={20} className="text-text-muted shrink-0" />
          <p className="text-sm text-text-secondary">
            {isCityClosed(city, stats.run.business_date, stats.calendar) ? (
              <>
                <b>{stats.run.business_date}</b> was your day off — no gate register, ops sheet
                or delivery-app entries are expected for this day.
              </>
            ) : (
              <>
                Tomorrow is your weekly off, so the guard register for{" "}
                <b>{stats.run.business_date}</b> is handed over the day after. These figures fill in
                then — an absent register today is on schedule, not overdue.
              </>
            )}
          </p>
        </div>
      )}

      {/* KPI grid — loss-only. Posting-lag / hygiene (INFO) rows stay in the DB
          for audit but are excluded from these counts (see hidden-count note). */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <button
          onClick={() => setListRequest({ bucket: "REAL", status: "ALL", title: "All loss variances" })}
          className="kpi-tile kpi-tile--danger card-hover text-left group cursor-pointer"
        >
          <div className="p-2 bg-danger-soft text-danger rounded-control w-fit mb-4"><Icon name="warning" size={22} /></div>
          <p className="kpi-label group-hover:underline">Not accounted for</p>
          <h3 className="kpi-value text-danger mt-1">{statsLoading ? "…" : cityAgg?.real ?? 0}</h3>
          <span className="text-xs text-text-muted mt-1 block">{rateCaption(cityAgg)}</span>
        </button>
        <button
          onClick={() => setListRequest({ bucket: "REAL", status: "open", title: "Open losses" })}
          className="kpi-tile card-hover text-left group cursor-pointer"
        >
          <div className="p-2 bg-accent-soft text-accent rounded-control w-fit mb-4"><Icon name="pending_actions" size={22} /></div>
          <p className="kpi-label group-hover:underline">Still open</p>
          <h3 className="kpi-value mt-1">{statsLoading ? "…" : cityAgg?.openReal ?? 0}</h3>
          <span className="text-xs text-text-muted mt-1 block">{queueCaption(cityAgg)}</span>
        </button>
        <button
          onClick={() =>
            setListRequest({ bucket: "REAL", status: "pending_approval", title: "Awaiting approval" })
          }
          className="kpi-tile card-hover text-left group cursor-pointer"
        >
          <div className="p-2 bg-surface-elevated rounded-control text-accent w-fit mb-4"><Icon name="approval" size={22} /></div>
          <p className="kpi-label group-hover:underline">With the admin</p>
          {/* REAL-scoped, matching the list this tile opens. */}
          <h3 className="kpi-value mt-1">{statsLoading ? "…" : cityAgg?.pendingApprovalReal ?? 0}</h3>
          <span className="text-xs text-text-muted mt-1 block">
            {(cityAgg?.pendingApprovalReal ?? 0) > 0
              ? "Submitted — nothing more for you to do on these"
              : "Nothing waiting on the admin"}
          </span>
        </button>
        <button
          onClick={() => setListRequest({ bucket: "REAL", status: "closed", title: "Closed variances" })}
          className="kpi-tile kpi-tile--success card-hover text-left group cursor-pointer"
        >
          <div className="p-2 bg-success-soft text-success rounded-control w-fit mb-4"><Icon name="task_alt" size={22} /></div>
          <p className="kpi-label group-hover:underline">Closed today</p>
          {/* LOSSES ONLY, matching the list this tile opens — it used to count
              every bucket, so the number and the list behind it disagreed. */}
          <h3 className="kpi-value mt-1">{statsLoading ? "…" : cityAgg?.closedReal ?? 0}</h3>
          <span className="text-xs text-text-muted mt-1 block">{closedCaption(cityAgg)}</span>
          {/* Pending-list items are stored as closed, so they land in the count
              above. Naming them stops the tile reading as "all finished". */}
          {(cityAgg?.pendingListReal ?? 0) > 0 && (
            <span className="text-xs text-status-warning mt-1 block">
              {cityAgg?.pendingListReal} on the pending list
            </span>
          )}
        </button>
      </div>
      {!statsLoading && (cityAgg?.infoBucket ?? 0) > 0 && (
        <p className="text-xs text-text-disabled -mt-2">
          {cityAgg?.infoBucket} more items were checked and need nothing from you — late Odoo
          postings, barcode typos, paperwork written a day either side.{" "}
          <button
            onClick={() =>
              setListRequest({
                bucket: "INFO",
                status: "ALL",
                title: "Posting-lag & hygiene entries",
              })
            }
            className="underline hover:text-text-secondary"
          >
            View the list
          </button>
        </p>
      )}

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
        <span className="text-xs text-text-disabled">Counted by quantity, not by barcode — they never appear in the list below.</span>
      </div>

      {/* Variance table */}
      <section className="card overflow-hidden flex flex-col">
        <div className="p-4 border-b border-border flex flex-col lg:flex-row justify-between lg:items-center gap-3 bg-surface-elevated">
          <div>
            <h3 className="font-headline text-lg text-text-primary">Variance Table — {city}</h3>
            <p className="text-xs text-text-muted mt-0.5">
              {loading ? "Loading…" : `${total} record${total === 1 ? "" : "s"}`}
              {/* Always name the date in effect — a blank picker resolves to the
                  latest run, not to "every date ever". */}
              {!q && businessDate && (
                <span>
                  {" "}· business date <b className="text-text-secondary">{businessDate}</b>
                  {!dateF && " (latest run)"}
                </span>
              )}
              {q && <span className="text-accent"> · results for “{q}” across all dates (filters paused)</span>}
              {sortDegraded && (
                <span className="text-status-warning">
                  {" "}· sorted alphabetically (migration 0011 not applied)
                </span>
              )}
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
            {/* The date picker moved to the page header — it governs the KPI
                tiles too, not just this table. */}
            <select value={bucket} onChange={(e) => resetPage(setBucket)(e.target.value as Bucket | "ALL")} className="input-clean font-semibold cursor-pointer">
              <option value="ALL">All items</option>
              <option value="REAL">Needs chasing</option>
              <option value="INFO">Needs nothing</option>
            </select>
            <select value={priority} onChange={(e) => resetPage(setPriority)(e.target.value as Priority | "ALL")} className="input-clean cursor-pointer">
              <option value="ALL">Any priority</option>
              <option value="High">High</option>
              <option value="Medium">Medium</option>
              <option value="Info">Info</option>
            </select>
            <select value={statusF} onChange={(e) => resetPage(setStatusF)(e.target.value as VarianceStatus | "ALL" | "ACTIVE")} className="input-clean cursor-pointer">
              {/* "Needs action" spans open + in_progress. Flagging moves a row
                  to in_progress, and a plain "open" filter hid exactly the rows
                  the flag was meant to escalate. */}
              <option value="ACTIVE">Still needs someone</option>
              <option value="open">Open only</option>
              <option value="in_progress">Flagged / in progress</option>
              <option value="pending_approval">Pending Approval</option>
              <option value="closed">Closed</option>
              <option value="ALL">Any status</option>
            </select>
            {/* Variance type — lets a manager work one cause at a time instead
                of a mixed list. */}
            <select
              value={varianceName}
              onChange={(e) => resetPage(setVarianceName)(e.target.value)}
              className="input-clean cursor-pointer max-w-[220px]"
              title="Filter to one kind of variance"
            >
              <option value="ALL">All problem types</option>
              {varianceNames.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.value} ({f.real})
                </option>
              ))}
            </select>
            <select
              value={responsible}
              onChange={(e) => resetPage(setResponsible)(e.target.value)}
              className="input-clean cursor-pointer"
              title="Filter to the team that owns these"
            >
              <option value="ALL">All Owners</option>
              {responsibles.map((f) => (
                <option key={f.value} value={f.value}>
                  {responsibleLabel(f.value)} ({f.real})
                </option>
              ))}
            </select>
            {/* Ops type. Options come from the data, and the "(none)" bucket is
                explicit because job_type is null on a large share of rows — a
                filter that could not reach them would hide real losses. */}
            <select
              value={opsType}
              onChange={(e) => resetPage(setOpsType)(e.target.value)}
              className="input-clean cursor-pointer max-w-[200px]"
              title="Filter to one ops type"
            >
              <option value="ALL">All job types</option>
              {opsTypes.map((f) => (
                <option key={f.value} value={f.value}>
                  {opsTypeLabel(f.value)} ({f.real})
                </option>
              ))}
            </select>
            <button
              onClick={exportCsv}
              disabled={total === 0 || exporting}
              title={`Download all ${total} matching row${total === 1 ? "" : "s"} as CSV`}
              className="btn btn-primary disabled:opacity-40"
            >
              <Icon
                name={exporting ? "progress_activity" : "download"}
                size={18}
                className={exporting ? "animate-spin" : ""}
              />
              {exporting ? "Exporting…" : `Export ${total || ""}`.trim()}
            </button>
          </div>
        </div>

        {/* Mobile: card list (below md). The whole card opens the detail dialog,
            same as a desktop row — this is the primary surface for a manager on
            a phone, so it must reach the evidence panel. Inner buttons stop
            propagation so an action never also opens the dialog. */}
        <div className="md:hidden divide-y divide-border">
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
                  {/* A <div> can't take focus — this button is the keyboard route in. */}
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
                <span>{v.business_date}</span>
                <SourceBadge source={v.variance_source} />
                {v.job_type && <span>{opsTypeLabel(v.job_type)}</span>}
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
                    onClick={(e) => {
                      e.stopPropagation();
                      setSubmitting({ id: v.id, product: v.product ?? "", barcode: v.barcode });
                    }}
                    className="btn btn-compact btn-primary w-full mt-1"
                  >
                    Submit for Approval
                  </button>
                </>
              )}
            </div>
          ))}
          {loading && rows.length === 0 && <CardListSkeleton />}
          {!loading && rows.length === 0 && (
            <EmptyState
              compact
              icon={filtersActive ? "search_off" : "task_alt"}
              title={filtersActive ? "Nothing matches these filters" : `${city} is fully accounted for`}
              detail={
                filtersActive
                  ? "The rows may exist on another date or status."
                  : `Nothing open for ${city} on ${businessDate ?? "this run"}.`
              }
              actionLabel={filtersActive ? "Reset filters" : undefined}
              onAction={filtersActive ? clearFilters : undefined}
            />
          )}
        </div>

        {/* Tablet/desktop: full table (md+) */}
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
                <SortHeader label="Item" sortKey="product" state={sort} onSort={applySort} />
                <SortHeader label="Barcode" sortKey="barcode" state={sort} onSort={applySort} />
                <SortHeader label="Ticket" sortKey="ticket" state={sort} onSort={applySort} />
                <SortHeader label="Raised by" sortKey="source" state={sort} onSort={applySort} />
                <SortHeader label="Job type" sortKey="jobType" state={sort} onSort={applySort} />
                <SortHeader label="SO" sortKey="so" state={sort} onSort={applySort} />
                <SortHeader label="Problem" sortKey="variance" state={sort} onSort={applySort} />
                <SortHeader
                  label="Priority"
                  sortKey="priority"
                  state={sort}
                  onSort={applySort}
                  title="Sort by severity — High, Medium, Info"
                />
                <SortHeader label="Status" sortKey="status" state={sort} onSort={applySort} />
                <SortHeader
                  label="Open for"
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
                  <td className="max-w-[200px] truncate" title={v.product ?? ""}>{v.product ?? "—"}</td>
                  <td>
                    {/* A <tr> can't take focus — this is the keyboard route in. */}
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
                  <td className="text-text-secondary">{v.ticket_id ?? "—"}</td>
                  <td><SourceBadge source={v.variance_source} /></td>
                  <td className="text-text-secondary text-xs">{opsTypeLabel(v.job_type)}</td>
                  <td className="text-text-secondary">{v.so_number ?? "—"}</td>
                  <td className="max-w-[220px]" title={v.note ?? ""}>
                    {v.variance_name}
                    {/* A rejected submission used to look identical to one
                        nobody had touched — the admin's note was a hover
                        tooltip on the status badge, so on the desktop table the
                        only place the manager would ever see it, they wouldn't.
                        It is now on the row itself. */}
                    {v.status !== "closed" && v.rejection_note && (
                      <span className="mt-1 flex items-start gap-1.5 text-xs text-danger">
                        <Icon name="error" size={14} className="mt-px" />
                        <span>Sent back: {v.rejection_note}</span>
                      </span>
                    )}
                  </td>
                  <td><span className={PRIORITY_BADGE[v.priority]}>{v.priority}</span></td>
                  <td>
                    <span className={`${STATUS_BADGE[v.status]} uppercase`} title={v.closure_reason ?? v.rejection_note ?? undefined}>
                      {STATUS_LABEL[v.status]}
                    </span>
                  </td>
                  <td className="text-text-secondary whitespace-nowrap" title={formatTs(v.first_seen_at)}>
                    {ageLabel(v.first_seen_at)}
                  </td>
                  <td className="text-right">
                    {v.status === "closed" ? (
                      <button disabled className="btn btn-compact btn-ghost opacity-50 cursor-not-allowed">Closed</button>
                    ) : v.status === "pending_approval" ? (
                      <span className="badge badge-info" title={v.submit_note ?? undefined}>Pending approval</span>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setSubmitting({ id: v.id, product: v.product ?? "", barcode: v.barcode });
                        }}
                        className="btn btn-compact btn-primary"
                      >
                        {/* Naming the second attempt "Resubmit" is the only
                            thing on this row that says the first one came
                            back. */}
                        {v.rejection_note ? "Resubmit" : "Submit"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {loading && rows.length === 0 && <TableBodySkeleton cols={13} />}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={13}>
                    <EmptyState
                      icon={filtersActive ? "search_off" : "task_alt"}
                      title={filtersActive ? "Nothing matches these filters" : `${city} is fully accounted for`}
                      detail={
                        filtersActive
                          ? "The rows may exist on another date or status."
                          : `Nothing open for ${city} on ${businessDate ?? "this run"}.`
                      }
                      actionLabel={filtersActive ? "Reset filters" : undefined}
                      onAction={filtersActive ? clearFilters : undefined}
                    />
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

      <VarianceListModal
        request={listRequest}
        city={city}
        date={dateF || undefined}
        role={user.role}
        showCityColumn={false}
        onClose={() => setListRequest(null)}
        onDirty={() => {
          refetch();
          refetchStats();
        }}
      />

      <VarianceDetailModal
        variance={detail}
        role={user.role}
        onClose={() => setDetail(null)}
        onChanged={() => {
          refetch();
          refetchStats();
        }}
      />

      <BulkActionBar
        ids={sel.ids}
        role={user.role}
        pendingApprovalCount={0}
        onClear={sel.clear}
        onDone={() => {
          refetch();
          refetchStats();
        }}
      />
    </div>
  );
}
