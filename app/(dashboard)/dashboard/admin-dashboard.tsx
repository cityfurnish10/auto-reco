"use client";

// Admin dashboard — real reconciliation data from the RLS-scoped API routes
// (/api/stats/summary + /api/variances). Columns match the DB variances table:
// Date, City, Item Name, Barcode, Ticket ID, Source, Ops Type, SO Number,
// Variance, Priority, Status. Defaults to the REAL + open "chase list".

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { SessionUser } from "@/lib/demo-auth";
import { CITIES, type City } from "@/lib/sample-data";
import type {
  Bucket,
  Priority,
  VarianceDB,
  VarianceSource,
  VarianceStatus,
} from "@/lib/db/schema";
import { SourceBadge } from "@/components/source-badge";
import { Icon } from "@/components/icon";
import { errText, useToast } from "@/components/toast";
import CloseVarianceModal from "./close-variance-modal";
import VarianceDetailModal from "./variance-detail-modal";
import VarianceListModal, { type ListModalRequest } from "./variance-list-modal";
import { isCityClosed } from "@/lib/engine/schedule";
import { addDays } from "@/lib/engine/dates";
import { cityRateLine, closedCaption, queueCaption, rateCaption } from "@/lib/ui/stat-captions";
import {
  PRIORITY_BADGE,
  STATUS_BADGE,
  STATUS_LABEL,
  ageLabel,
  formatTs,
  opsTypeLabel,
} from "@/lib/ui/variance-format";
import { downloadCsv, varianceRowsToCsv } from "@/lib/ui/variance-csv";
import { SortHeader, type SortState } from "@/components/sort-header";
import { RowCheckbox, SelectAllCheckbox } from "@/components/row-checkbox";
import { CardListSkeleton, TableBodySkeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { StaleRunBanner } from "./stale-run-banner";
import { useSelection } from "@/lib/hooks/use-selection";
import { useStickyState } from "@/lib/hooks/use-sticky-state";
import BulkActionBar from "./bulk-action-bar";
import { responsibleLabel } from "@/lib/ui/variance-format";
import {
  useStats,
  useVariances,
  useVarianceFacets,
  patchVariance,
  fetchAllVariances,
  type VarianceFilters,
} from "@/lib/hooks/use-dashboard-data";
import { shownBarcode } from "@/lib/ui/barcode-display";

type CityTab = "ALL" | City;

const SOURCES: VarianceSource[] = ["Odoo", "DT", "Sheet", "Physical", "Cross"];
const PAGE_SIZE = 25;

export default function AdminDashboard({ user }: { user: SessionUser }) {
  const toast = useToast();
  // Sticky alongside the date — remembering one but not the other leaves you
  // back on "ALL CITIES" for the day you picked, which reads as a bug.
  const [cityTab, setCityTab] = useStickyState<CityTab>("admin.cityTab", "ALL");
  const [bucket, setBucket] = useState<Bucket | "ALL">("REAL");
  const [source, setSource] = useState<VarianceSource | "ALL">("ALL");
  const [priority, setPriority] = useState<Priority | "ALL">("ALL");
  const [status, setStatus] = useState<VarianceStatus | "ALL" | "ACTIVE">("ACTIVE");
  const [varianceName, setVarianceName] = useState<string>("ALL");
  const [responsible, setResponsible] = useState<string>("ALL");
  const [opsType, setOpsType] = useState<string>("ALL");
  const [sort, setSort] = useState<SortState>({ key: "date", dir: "desc" });
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  // Sticky: survives navigating to another page and back, so a date the
  // user deliberately picked is not silently reset to the latest run.
  const [dateF, setDateF] = useStickyState("admin.businessDate", ""); // "" = latest run
  // Span every date rather than the latest run. Set only by the approvals bell,
  // whose badge counts across all dates; cleared the moment a date is picked.
  const [allDates, setAllDates] = useState(false);
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [rejecting, setRejecting] = useState<{ id: string; product: string; barcode: string } | null>(null);
  const [resolving, setResolving] = useState<{ id: string; product: string; barcode: string } | null>(null);

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
  //
  // AND CLEAR THE OTHER FILTERS, because the badge counts across all of them.
  // /api/variances/pending-count filters on status alone — every city, every
  // bucket, every date — while this page arrives holding a sticky city and date
  // from the last visit and a bucket defaulting to REAL. So the badge said 12,
  // the click landed on one city's REAL rows for one day, and the queue looked
  // like 3. The badge is the promise; this makes the page keep it.
  /* eslint-disable react-hooks/set-state-in-effect -- one-time URL seed on mount */
  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get("status");
    if (s !== "pending_approval") return;
    setStatus("pending_approval");
    setCityTab("ALL");
    setBucket("ALL");
    setDateF("");
    setAllDates(true); // the badge counts every date, so the list must show them
  }, [setCityTab, setDateF]);
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
      variance: q ? "ALL" : varianceName,
      responsible: q ? "ALL" : responsible,
      jobType: q ? "ALL" : opsType,
      date: q || allDates ? undefined : dateF || undefined,
      // A search must find the barcode whatever night it landed on, and the
      // approvals queue must show every date the badge counted; everything else
      // stays scoped to a single run so the table agrees with the KPIs.
      allDates: !!q || allDates,
      q: q || undefined,
      sort: sort.key,
      dir: sort.dir,
      page,
      pageSize: PAGE_SIZE,
    }),
    [cityTab, bucket, source, priority, status, varianceName, responsible, opsType, dateF, allDates, q, sort, page]
  );
  const { rows, total, totalPages, businessDate, sortDegraded, loading, error, refetch } =
    useVariances(filters);

  // Options come from the data in scope, so the dropdowns only ever offer
  // filters that will return something.
  const { varianceNames, responsibles, opsTypes } = useVarianceFacets({
    city: cityTab,
    date: dateF || undefined,
  });

  // Selection deliberately survives paging — picking 20 on page 1 and 15 on
  // page 2, then acting on all 35, is the workflow bulk actions exist for.
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

  // Bulk approve/reject only apply to rows actually awaiting approval — the bar
  // shows that count so "Approve 30" never means "…and silently skip 12".
  const selectedPendingApproval = useMemo(
    () => rows.filter((r) => sel.has(r.id) && r.status === "pending_approval").length,
    [rows, sel]
  );

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

  const agg = useMemo(() => {
    if (!stats) return null;
    return cityTab === "ALL"
      ? stats.overall
      : stats.byCity.find((c) => c.city === cityTab) ?? {
          city: cityTab, total: 0, open: 0, inProgress: 0, pendingApproval: 0, closed: 0,
          pendingList: 0, openReal: 0, inProgressReal: 0, pendingApprovalReal: 0, closedReal: 0,
          pendingListReal: 0, high: 0, medium: 0, info: 0, real: 0, infoBucket: 0, ppBox: 0, consumable: 0,
          // A city with no row in this run moved nothing we recorded. movements
          // 0 makes rateCaption say "No movements recorded for this day" rather
          // than inventing a perfect score out of a zero denominator.
          movements: 0, openOver3d: 0, oldestOpenAt: null,
        };
  }, [stats, cityTab]);

  function resetPage<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v);
      setPage(1);
      // Touching any filter means the user is driving now, not the bell.
      setAllDates(false);
      // A filter change redefines what the user is looking at, so a selection
      // made under the old filters must not survive into a bulk action. Paging
      // deliberately does NOT clear it — see use-selection.ts.
      sel.clear();
    };
  }

  // Sorting is server-side (the table is paginated), so a new sort has to start
  // from page 1 — otherwise you land on page 4 of a completely different order.
  function applySort(next: SortState) {
    setSort(next);
    setPage(1);
  }

  // Any filter is on = the empty state is recoverable, so offer the way out.
  const filtersActive =
    cityTab !== "ALL" ||
    bucket !== "REAL" ||
    source !== "ALL" ||
    priority !== "ALL" ||
    status !== "ACTIVE" ||
    varianceName !== "ALL" ||
    responsible !== "ALL" ||
    opsType !== "ALL" ||
    !!dateF ||
    !!q;

  function clearFilters() {
    setCityTab("ALL");
    setBucket("REAL");
    setSource("ALL");
    setPriority("ALL");
    setStatus("ACTIVE");
    setVarianceName("ALL");
    setResponsible("ALL");
    setOpsType("ALL");
    setDateF("");
    setSearchInput("");
    setPage(1);
    sel.clear();
  }

  // Resolving the last row on page 8 drops the total to 7 pages and strands you
  // on a page that no longer exists — "No variances match" above "Page 8 of 7".
  /* eslint-disable react-hooks/set-state-in-effect -- clamp after a load */
  useEffect(() => {
    if (!loading && totalPages > 0 && page > totalPages) setPage(totalPages);
  }, [loading, totalPages, page]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Drill-down from a KPI tile opens a dialog over the page — the table below
  // keeps whatever filters and search the admin already had.
  const [listRequest, setListRequest] = useState<ListModalRequest | null>(null);
  const [detail, setDetail] = useState<VarianceDB | null>(null);
  function refreshAll() {
    refetch();
    refetchStats();
  }

  // Shared by the desktop row and the mobile card. Don't hijack a click that
  // was really the end of a text selection.
  function openDetail(v: VarianceDB) {
    if (window.getSelection()?.isCollapsed === false) return;
    setDetail(v);
  }

  async function dispute(id: string) {
    setBusyId(id);
    try {
      await patchVariance(id, "dispute");
      toast.success("Flagged — escalated to the city manager.");
      refetch();
      refetchStats();
    } catch (e) {
      toast.error("Could not flag this variance.", { detail: errText(e) });
    } finally {
      setBusyId(null);
    }
  }

  // Approve a manager's submission → closes the variance (carries their reason).
  async function approve(id: string) {
    setBusyId(id);
    try {
      await patchVariance(id, "approve");
      toast.success("Approved and closed.");
      refetch();
      refetchStats();
    } catch (e) {
      toast.error("Could not approve this submission.", { detail: errText(e) });
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
      toast.success(`${rejecting.barcode} sent back to the manager.`);
      refetch();
      refetchStats();
    } catch (e) {
      toast.error("Could not reject this submission.", { detail: errText(e) });
    }
  }

  // Admin resolves a variance directly — closes it with a reason + comment,
  // no manager submission needed (the API's admin-only "close" action).
  async function handleResolve(reason: string, note: string) {
    if (!resolving) return;
    try {
      await patchVariance(resolving.id, "close", reason || undefined, note);
      setResolving(null);
      toast.success(`${resolving.barcode} resolved.`);
      refetch();
      refetchStats();
    } catch (e) {
      toast.error("Could not resolve this variance.", { detail: errText(e) });
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
        `variances_${cityTab.toLowerCase()}_${businessDate ?? "all-dates"}.csv`,
        varianceRowsToCsv(all)
      );
      if (truncated) {
        toast.info(`Exported the first ${all.length} rows.`, {
          detail: "That's the export cap — narrow by city, status or date to get the rest.",
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

  // The "(latest available)" parenthetical is gone — it is a banner now, since
  // it means every number on the page describes a different day.
  const runLabel = stats?.run
    ? `Run ${stats.run.business_date} · ${stats.run.status}`
    : "No reconciliation run yet";

  return (
    <section className="p-container-margin space-y-8">
      {stats?.usedFallbackRun && stats.run && (
        <StaleRunBanner
          showingDate={stats.run.business_date}
          requestedDate={dateF || undefined}
          onClear={dateF ? () => resetPage(setDateF)("") : undefined}
        />
      )}

      {/* City tabs + the business-date picker.
          The picker lives here, not in the table toolbar below, because it does
          not only filter the table: the same `dateF` drives the KPI tiles, the
          count-only movements card, the city breakdown and the facet counts.
          Sitting inside the table's header understated its reach. */}
      <div className="border-b border-border flex items-end justify-between gap-4">
        <div className="flex gap-1 overflow-x-auto scrollbar-hide">
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
        <div className="flex items-center gap-2 pb-2 shrink-0">
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

      {/* KPI cards — loss-only. Posting-lag / hygiene (INFO) rows are kept in the
          DB for audit but excluded from these counts (see the hidden-count note). */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="kpi-tile kpi-tile--accent flex flex-col justify-between group">
          <button
            onClick={() =>
              setListRequest({ bucket: "REAL", status: "ALL", title: "All loss variances" })
            }
            title="Open every loss variance"
            className="w-full text-left flex flex-col cursor-pointer"
          >
            <span className="kpi-label group-hover:underline">Not accounted for</span>
            <div className="flex items-end justify-between mt-2">
              <span className="kpi-value">{statsLoading ? "…" : agg?.real ?? 0}</span>
              {/* "High" is an enum value; "urgent" is what it means. Safe to
                  trust: applyBucket forces every INFO row to Info priority, so a
                  High row is a loss by construction. */}
              {(agg?.high ?? 0) > 0 && <span className="badge badge-high">{agg?.high} urgent</span>}
            </div>
            <span className="text-xs text-text-muted mt-1">
              {rateCaption(agg)}
            </span>
          </button>
        </div>
        <div className="kpi-tile kpi-tile--danger flex flex-col justify-between group">
          <button
            onClick={() =>
              setListRequest({ bucket: "REAL", status: "open", title: "Open losses" })
            }
            title="Open the losses awaiting action"
            className="w-full text-left flex flex-col cursor-pointer"
          >
            <span className="kpi-label group-hover:underline">Still open</span>
            <span className="kpi-value mt-2">{statsLoading ? "…" : agg?.openReal ?? 0}</span>
          </button>
          <span className="text-xs text-text-muted mt-1">
            {/* REAL-scoped, because that is what the click opens. */}
            {(agg?.pendingApprovalReal ?? 0) > 0 ? (
              <button
                onClick={() =>
                  setListRequest({
                    bucket: "REAL",
                    status: "pending_approval",
                    title: "Awaiting your approval",
                  })
                }
                className="text-accent font-semibold hover:underline"
              >
                {agg?.pendingApprovalReal} pending approval
              </button>
            ) : (
              queueCaption(agg)
            )}
          </span>
        </div>
        <div className="kpi-tile flex flex-col justify-between group">
          <button
            onClick={() =>
              setListRequest({ bucket: "REAL", status: "closed", title: "Resolved losses" })
            }
            title="Open the resolved losses"
            className="w-full text-left flex flex-col cursor-pointer"
          >
            <span className="kpi-label group-hover:underline">Closed today</span>
            {/* LOSSES ONLY, matching the list this opens. It used to show
                `closed` across every bucket, so the tile read 88 and the list
                behind it held 31 — and the ratio to `real` could exceed 100%,
                which is why this tile was left relating itself to nothing. */}
            <span className="kpi-value mt-2">{statsLoading ? "…" : agg?.closedReal ?? 0}</span>
            <span className="text-xs text-text-muted mt-1">
              {closedCaption(agg)}
            </span>
          </button>
          {/* Pending-list items are stored as closed, so they land in the count
              above. Naming them stops the tile reading as "all finished". */}
          {(agg?.pendingListReal ?? 0) > 0 && (
            <Link
              href="/pending-list"
              className="text-xs text-status-warning hover:underline mt-1"
            >
              {agg?.pendingListReal} of these are on the pending list
            </Link>
          )}
        </div>
      </div>
      {!statsLoading && (agg?.infoBucket ?? 0) > 0 && (
        <p className="text-xs text-text-disabled -mt-2">
          {agg?.infoBucket} more items were checked and need nothing from you — late Odoo
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
        <span className="text-xs text-text-disabled">Counted by quantity, not by barcode — they never appear in the list below.</span>
      </div>

      {/* City-wise breakdown */}
      {cityTab === "ALL" && stats && stats.byCity.length > 0 && (
        <div className="space-y-4">
          <h3 className="font-headline text-lg text-text-primary">City-wise Breakdown</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
            {stats.byCity.map((c) => {
              // Weekly holiday: the warehouse was closed — neutral border + OFF
              // badge so empty numbers read as "expected", not as a data gap.
              // ONE badge per week, on the off date only (the owner's rule).
              // CALENDAR-AWARE (migration 0019): the delivery app's own
              // weekly-off rules plus its 27 one-off holidays, mirrored into
              // Supabase each run. Null calendar = pre-0019 database, and
              // isCityClosed then falls back to the hardcoded Thursday map, so
              // this line is correct on every vintage of database.
              const bd = stats.run?.business_date ?? "";
              const off = bd !== "" && isCityClosed(c.city as City, bd, stats.calendar);
              const isHoliday = off && !!stats.calendar?.holidays?.[c.city]?.includes(bd);
              // The day BEFORE a closure: the city works this whole board, but
              // its guard register is handed over AFTER the day off — the book
              // from a Thursday-off warehouse arrives Friday. A schedule, not a
              // gap, so it gets its own chip rather than a closure badge.
              const registerDue = bd !== "" && !off && isCityClosed(c.city as City, addDays(bd, 1), stats.calendar);
              return (
              <div
                key={c.city}
                className={`card card-hover p-4 flex flex-col gap-3 border-l-[3px] ${
                  off ? "border-l-border" : c.real > 0 ? "border-l-danger" : "border-l-success"
                }`}
              >
                <div className="flex justify-between items-start">
                  <h4 className="font-headline text-base text-text-primary flex items-center gap-2">
                    {c.city}
                    {off && (
                      <span
                        className="badge badge-suppressed uppercase"
                        title={
                          isHoliday
                            ? "Holiday — the delivery app's calendar marks this warehouse shut on this date, so no floor entries are expected"
                            : "Weekly off — the warehouse was shut, so no gate register, ops sheet or delivery-app entries are expected for this day"
                        }
                      >
                        {isHoliday ? "Holiday" : "Week off"}
                      </span>
                    )}
                    {!off && registerDue && (
                      <span
                        className="badge badge-suppressed uppercase"
                        title="Tomorrow is this warehouse's weekly off, so today's guard register is handed over the day AFTER the holiday — not tomorrow. The numbers here fill in then; an absent register today is on schedule, not overdue."
                      >
                        Register after day off
                      </span>
                    )}
                  </h4>
                  <span className={`font-bold text-lg ${off ? "text-text-disabled" : c.real > 0 ? "text-danger" : "text-success"}`}>
                    {c.real}
                  </span>
                </div>
                <div className="text-xs text-text-muted">
                  {off ? (
                    <span>
                      {isHoliday ? "Holiday" : "Weekly off"} — the warehouse was shut, so nothing
                      is expected
                    </span>
                  ) : (
                    <>
                      <span className="text-danger font-semibold">{cityRateLine(c)}</span>{" · "}
                      {c.openReal} open
                    </>
                  )}
                </div>
                {/* WHO SAW THESE MOVEMENTS. Without it a reader assumes every
                    movement was witnessed on the floor. Measured 2026-07-29:
                    Mumbai 123 of 172 were seen by Odoo alone, while Pune's 33 of
                    33 were the exact opposite — the floor logged them and Odoo
                    has not posted them, which is a backlog, not missing stock. */}
                {!off && c.ledgered > 0 && c.floorNotInOdoo > 0 && (
                  <div className="text-xs text-status-warning">
                    Waiting on Odoo — {c.floorNotInOdoo} of {c.ledgered} the floor
                    recorded are not posted yet
                  </div>
                )}
                {!off && c.ledgered > 0 && c.odooOnly > 0 && (
                  <div className="text-xs text-text-muted">
                    Only Odoo saw {c.odooOnly} of {c.ledgered} — no floor record
                  </div>
                )}
                {!off && registerDue && (
                  <div className="text-xs text-text-muted">
                    Tomorrow is this warehouse&apos;s weekly off, so today&apos;s guard
                    register is handed over the day after the holiday — these numbers
                    fill in then. Absent today is on schedule, not overdue.
                  </div>
                )}
                <div className="text-xs text-text-disabled">
                  PP boxes {c.ppBox} · Consumables {c.consumable} — counted, not chased
                </div>
                <button
                  onClick={() => resetPage(setCityTab)(c.city as City)}
                  className="btn btn-compact btn-secondary w-full"
                >
                  VIEW DETAIL
                </button>
              </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Variance table — rows open the detail dialog */}
      <div className="card overflow-hidden">
        <div className="p-4 border-b border-border bg-surface-elevated flex flex-col lg:flex-row justify-between lg:items-center gap-4">
          <div>
            <h3 className="font-headline text-lg text-text-primary">
              {cityTab === "ALL" ? "All Cities" : cityTab} Variances
            </h3>
            <p className="text-xs text-text-muted mt-0.5">
              {loading ? "Loading…" : `${total} record${total === 1 ? "" : "s"}`}
              {/* Always name the date in effect. A blank picker used to mean
                  "every date ever", which quietly disagreed with the KPI tiles
                  above; it now resolves to the latest run and says so. */}
              {!q && businessDate && (
                <span>
                  {" "}· business date <b className="text-text-secondary">{businessDate}</b>
                  {!dateF && " (latest run)"}
                </span>
              )}
              {q && <span className="text-accent"> · results for “{q}” across all dates (filters paused)</span>}
              {/* Never present an alphabetical order as if it were the severity
                  order that was asked for — see migration 0011. */}
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
                tiles and city breakdown too, not just this table. */}
            <select value={bucket} onChange={(e) => resetPage(setBucket)(e.target.value as Bucket | "ALL")} className="input-clean font-semibold cursor-pointer">
              <option value="ALL">All items</option>
              <option value="REAL">Needs chasing</option>
              <option value="INFO">Needs nothing</option>
            </select>
            <select value={source} onChange={(e) => resetPage(setSource)(e.target.value as VarianceSource | "ALL")} className="input-clean font-semibold cursor-pointer">
              <option value="ALL">Raised by any check</option>
              {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={priority} onChange={(e) => resetPage(setPriority)(e.target.value as Priority | "ALL")} className="input-clean font-semibold cursor-pointer">
              <option value="ALL">Any priority</option>
              <option value="High">High</option>
              <option value="Medium">Medium</option>
              <option value="Info">Info</option>
            </select>
            <select value={status} onChange={(e) => resetPage(setStatus)(e.target.value as VarianceStatus | "ALL" | "ACTIVE")} className="input-clean font-semibold cursor-pointer">
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
            {/* Variance type — this is what makes the digest's "Top Gap: 57
                losses share one cause" line actionable. */}
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
            {/* Owner — triage is a routing job, and this is the routing field. */}
            <select
              value={responsible}
              onChange={(e) => resetPage(setResponsible)(e.target.value)}
              className="input-clean cursor-pointer"
              title="Filter to the team that owns these"
            >
              <option value="ALL">All teams</option>
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
            same as a desktop row — managers work from a phone, and without this
            the evidence panel was unreachable for them. Inner buttons stop
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
                <span>{v.business_date}</span>
                <span>{v.city}</span>
                <SourceBadge source={v.variance_source} />
                {v.job_type && <span>{opsTypeLabel(v.job_type)}</span>}
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
                    onClick={(e) => {
                      e.stopPropagation();
                      approve(v.id);
                    }}
                    disabled={busyId === v.id}
                    className="btn btn-compact btn-primary flex-1 disabled:opacity-40"
                  >
                    <Icon name="check_circle" size={16} /> Approve
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setRejecting({ id: v.id, product: v.product ?? "", barcode: shownBarcode(v) });
                    }}
                    disabled={busyId === v.id}
                    className="btn btn-compact btn-secondary flex-1 disabled:opacity-40"
                  >
                    <Icon name="close" size={16} /> Reject
                  </button>
                </div>
              ) : v.status === "open" || v.status === "in_progress" ? (
                <div className="flex gap-2 mt-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setResolving({ id: v.id, product: v.product ?? "", barcode: shownBarcode(v) });
                    }}
                    disabled={busyId === v.id}
                    className="btn btn-compact btn-primary flex-1 disabled:opacity-40"
                  >
                    <Icon name="task_alt" size={16} /> Resolve
                  </button>
                  {v.status === "open" && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        dispute(v.id);
                      }}
                      disabled={busyId === v.id}
                      className="btn btn-compact btn-secondary flex-1 disabled:opacity-40"
                    >
                      <Icon name="flag" size={16} /> Flag
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          ))}
          {loading && rows.length === 0 && <CardListSkeleton />}
          {!loading && rows.length === 0 && (
            <EmptyState
              compact
              icon={filtersActive ? "search_off" : "task_alt"}
              title={filtersActive ? "Nothing matches these filters" : "Everything is accounted for"}
              detail={
                filtersActive
                  ? "The rows may exist on another date, city or status."
                  : `No open losses for ${businessDate ?? "this run"}.`
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
                <SortHeader label="City" sortKey="city" state={sort} onSort={applySort} />
                <SortHeader label="Item" sortKey="product" state={sort} onSort={applySort} />
                <SortHeader label="Barcode" sortKey="barcode" state={sort} onSort={applySort} />
                <SortHeader label="Ticket" sortKey="ticket" state={sort} onSort={applySort} />
                <SortHeader label="Raised by" sortKey="source" state={sort} onSort={applySort} />
                <SortHeader label="Job type" sortKey="jobType" state={sort} onSort={applySort} />
                <SortHeader label="SO" sortKey="so" state={sort} onSort={applySort} />
                <SortHeader label="Problem" sortKey="variance" state={sort} onSort={applySort} />
                <SortHeader
                  label="Team"
                  sortKey="responsible"
                  state={sort}
                  onSort={applySort}
                  title="Sort by the team that has to fix it"
                />
                <SortHeader
                  label="Priority"
                  sortKey="priority"
                  state={sort}
                  onSort={applySort}
                  title="Sort by urgency — High, Medium, Info"
                />
                <SortHeader label="Status" sortKey="status" state={sort} onSort={applySort} />
                <SortHeader
                  label="Open for"
                  sortKey="age"
                  state={sort}
                  onSort={applySort}
                  title="Sort by how long this has gone unfixed"
                />
                <th className="text-center">Action</th>
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
                      label={`Select ${shownBarcode(v)}`}
                    />
                  </td>
                  <td className="whitespace-nowrap text-text-secondary">{v.business_date}</td>
                  <td>{v.city}</td>
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
                      {shownBarcode(v)}
                    </button>
                  </td>
                  <td className="text-text-secondary">{v.ticket_id ?? "—"}</td>
                  <td><SourceBadge source={v.variance_source} /></td>
                  <td className="text-text-secondary text-xs">{opsTypeLabel(v.job_type)}</td>
                  <td className="text-text-secondary">{v.so_number ?? "—"}</td>
                  <td className="max-w-[220px]" title={v.note ?? ""}>
                    <span className="text-text-primary">{v.variance_name}</span>
                  </td>
                  <td className="text-text-secondary whitespace-nowrap">
                    {responsibleLabel(v.responsible)}
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
                  <td className="text-text-secondary whitespace-nowrap" title={formatTs(v.first_seen_at)}>
                    {ageLabel(v.first_seen_at)}
                  </td>
                  <td className="text-center">
                    {v.status === "pending_approval" ? (
                      <div className="inline-flex items-center gap-1">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            approve(v.id);
                          }}
                          disabled={busyId === v.id}
                          title="Approve — closes this variance"
                          className="btn-icon hover:text-success disabled:opacity-40"
                        >
                          <Icon name="check_circle" size={18} />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setRejecting({ id: v.id, product: v.product ?? "", barcode: shownBarcode(v) });
                          }}
                          disabled={busyId === v.id}
                          title="Reject — send back to the manager"
                          className="btn-icon hover:text-danger disabled:opacity-40"
                        >
                          <Icon name="close" size={18} />
                        </button>
                      </div>
                    ) : v.status === "open" || v.status === "in_progress" ? (
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setResolving({ id: v.id, product: v.product ?? "", barcode: shownBarcode(v) });
                          }}
                          disabled={busyId === v.id}
                          title="Close with a reason and comment"
                          className="btn btn-compact btn-primary disabled:opacity-40"
                        >
                          Resolve
                        </button>
                        {v.status === "open" && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              dispute(v.id);
                            }}
                            disabled={busyId === v.id}
                            title="Flag as disputed — escalate to city manager"
                            className="btn btn-compact btn-secondary disabled:opacity-40"
                          >
                            Flag
                          </button>
                        )}
                      </div>
                    ) : (
                      <span className="text-text-disabled inline-flex p-1" title={v.status}>
                        <Icon name="task_alt" size={18} />
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {loading && rows.length === 0 && <TableBodySkeleton cols={15} />}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={15}>
                    <EmptyState
                      icon={filtersActive ? "search_off" : "task_alt"}
                      title={
                        filtersActive ? "Nothing matches these filters" : "Everything is accounted for"
                      }
                      detail={
                        filtersActive
                          ? "The rows may exist on another date, city or status."
                          : `No open losses for ${businessDate ?? "this run"}.`
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

      {resolving && (
        <CloseVarianceModal
          itemName={resolving.product}
          itemCode={resolving.barcode}
          title="Resolve Variance"
          confirmLabel="Resolve & Close"
          notePlaceholder="Add a comment about how this was resolved…"
          onConfirm={handleResolve}
          onCancel={() => setResolving(null)}
        />
      )}

      <VarianceListModal
        request={listRequest}
        city={cityTab}
        date={dateF || undefined}
        role={user.role}
        onClose={() => setListRequest(null)}
        onDirty={refreshAll}
      />

      <VarianceDetailModal
        variance={detail}
        role={user.role}
        onClose={() => setDetail(null)}
        onChanged={refreshAll}
      />

      <BulkActionBar
        ids={sel.ids}
        role={user.role}
        pendingApprovalCount={selectedPendingApproval}
        onClear={sel.clear}
        onDone={refreshAll}
      />
    </section>
  );
}
