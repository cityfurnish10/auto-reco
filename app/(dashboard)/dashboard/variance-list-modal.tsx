"use client";

// A KPI tile's full drill-down, in place. Opening this leaves the page (and
// whatever filters the user had set on it) completely untouched — it owns its
// own query, filters and pagination, and hands each row on to the detail
// dialog.

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { Modal } from "@/components/modal";
import { SourceBadge } from "@/components/source-badge";
import VarianceDetailModal from "./variance-detail-modal";
import type { SessionUser } from "@/lib/demo-auth";
import type { Bucket, Priority, VarianceDB, VarianceStatus } from "@/lib/db/schema";
import type { City } from "@/lib/sample-data";
import { patchVariance, useVariances } from "@/lib/hooks/use-dashboard-data";
import {
  PRIORITY_BADGE,
  STATUS_BADGE,
  STATUS_LABEL,
} from "@/lib/ui/variance-format";

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
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Keeps the detail dialog painted even if a refetch drops the row from the
  // current page (e.g. resolving it while filtered to "open"). State, not a
  // ref, because it is read during render.
  const [snapshot, setSnapshot] = useState<VarianceDB | null>(null);
  // Actions here shouldn't refetch the page behind the overlay on every click;
  // the parent syncs once, on close.
  const dirty = useRef(false);

  // Seed from the tile that opened us, and reset per opening.
  /* eslint-disable react-hooks/set-state-in-effect -- seed on open */
  useEffect(() => {
    if (!request) return;
    setBucket(request.bucket);
    setStatus(request.status);
    setPriority("ALL");
    setSearchInput("");
    setQ("");
    setPage(1);
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
    allDates: !!q,
    q: q || undefined,
    page,
    pageSize: PAGE_SIZE,
  });

  const selected = rows.find((r) => r.id === selectedId) ?? snapshot;

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
      dirty.current = true;
      refetch();
    } catch (e) {
      alert(`Could not ${label}: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusyId(null);
    }
  }

  const isAdmin = role === "ADMIN";
  const colCount = showCityColumn ? 9 : 8;

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
        onChange={(e) => {
          setBucket(e.target.value as Bucket | "ALL");
          setPage(1);
        }}
        className="input-clean font-semibold cursor-pointer"
      >
        <option value="ALL">All buckets</option>
        <option value="REAL">Losses only</option>
        <option value="INFO">Audit only</option>
      </select>
      <select
        value={status}
        onChange={(e) => {
          setStatus(e.target.value as VarianceStatus | "ALL");
          setPage(1);
        }}
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
        onChange={(e) => {
          setPriority(e.target.value as Priority | "ALL");
          setPage(1);
        }}
        className="input-clean font-semibold cursor-pointer"
      >
        <option value="ALL">All priority</option>
        <option value="High">High</option>
        <option value="Medium">Medium</option>
        <option value="Info">Info</option>
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
        footer={pager}
        bodyClassName="p-0"
      >
        {/* Mobile: cards */}
        <div className="md:hidden divide-y divide-border">
          {rows.map((v) => (
            <button
              key={v.id}
              onClick={() => openDetail(v)}
              className="w-full text-left p-4 space-y-1.5 hover:bg-surface-elevated transition-colors"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono font-semibold text-text-primary text-sm break-all">
                  {v.barcode}
                </span>
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
              </div>
            </button>
          ))}
          {!loading && rows.length === 0 && (
            <div className="text-center py-12 text-text-muted flex flex-col items-center gap-2">
              <Icon name="search_off" size={32} className="text-text-disabled" />
              No variances match these filters.
            </div>
          )}
        </div>

        {/* Desktop: table */}
        <div className="hidden md:block">
          <table className="table-clean table-sticky-head">
            <thead>
              <tr>
                <th>Item</th>
                <th>Barcode</th>
                {showCityColumn && <th>City</th>}
                <th>Ticket</th>
                <th>Source</th>
                <th>Variance</th>
                <th>Priority</th>
                <th>Status</th>
                <th className="text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr
                  key={v.id}
                  onClick={() => openDetail(v)}
                  className={`cursor-pointer ${selectedId === v.id ? "bg-surface-elevated" : ""}`}
                >
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
                      {v.barcode}
                    </button>
                  </td>
                  {showCityColumn && <td>{v.city}</td>}
                  <td className="text-text-secondary">{v.ticket_id ?? "—"}</td>
                  <td>
                    <SourceBadge source={v.variance_source} />
                  </td>
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
                  <td className="text-right">{rowActions(v)}</td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={colCount} className="text-center py-12 text-text-muted">
                    <div className="flex flex-col items-center gap-2">
                      <Icon name="search_off" size={32} className="text-text-disabled" />
                      No variances match these filters.
                    </div>
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
