"use client";

// The dashboard's four numbered sections, and section 1 itself.
//
// Asked for 18 Sep 2026 — "the whole page looks messy and un-sectioned". It had
// grown one card at a time: an in-transit card, a to-do strip, guard cards, a
// source table, loose sentences between them, a count-only card, the variance
// table. Each was right when added; together they read as a pile. The page now
// answers four questions in the order anybody asks them:
//
//   1  Day status          can this day be judged yet, and what is open
//   2  What moved          what each book recorded
//   3  Do the books agree  each book in turn as the source of truth
//   4  Variances           the units that do not line up
//
// Every explanatory sentence lives inside its section or behind a hover; none
// floats between cards.

import type { ReactNode } from "react";
import Link from "next/link";
import { statFigure, rateCaption } from "@/lib/ui/stat-captions";
import { SOURCE_NAME } from "@/lib/ui/source-names";
import type { CityAgg } from "@/lib/hooks/use-dashboard-data";
import type { ListModalRequest } from "./variance-list-modal";

/** A numbered section: heading row, optional right-hand slot, then its cards. */
export function DashSection({ n, title, subtitle, right, children }: {
  n: number;
  title: string;
  subtitle?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3" aria-labelledby={`dash-section-${n}`}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1 border-b border-border pb-2">
        <div className="flex items-baseline gap-3">
          <span className="w-6 h-6 rounded-full bg-accent-soft text-accent text-xs font-bold grid place-items-center shrink-0">
            {n}
          </span>
          <div>
            <h2 id={`dash-section-${n}`} className="font-headline text-lg text-text-primary leading-tight">{title}</h2>
            {subtitle && <p className="text-xs text-text-muted mt-0.5">{subtitle}</p>}
          </div>
        </div>
        {right && <div className="text-xs text-text-muted">{right}</div>}
      </div>
      {children}
    </section>
  );
}

function Tile({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="card px-4 py-3 flex flex-col gap-1 min-w-0" title={hint}>
      <span className="text-[11px] uppercase tracking-wider text-text-muted">{label}</span>
      <div className="text-sm text-text-primary min-w-0">{children}</div>
    </div>
  );
}

type ListRequest = ListModalRequest;

/**
 * Section 1 — can this day be judged, and what is open.
 *
 * "Open variances" was "to chase" until 18 Sep 2026 (owner's wording). It
 * counts OPEN losses, and opens exactly that list.
 */
export function DayStatus({ agg, loading, error, onOpenList }: {
  agg: CityAgg | null;
  loading: boolean;
  error: string | null;
  onOpenList: (r: ListRequest) => void;
}) {
  const books = [
    ["Guard Check", agg?.sources?.gate],
    [SOURCE_NAME.sheet, agg?.sources?.sheet],
    [SOURCE_NAME.dt, agg?.sources?.dt],
    [SOURCE_NAME.odoo, agg?.sources?.odoo],
  ] as const;
  const reported = books.filter(([, c]) => c?.reported).length;
  const silent = books.filter(([, c]) => c && !c.reported).map(([n]) => n);

  const end = agg?.odooWindowEnd ? new Date(agg.odooWindowEnd) : null;
  // eslint-disable-next-line react-hooks/purity -- a clock read for a status label, recomputed each render by design
  const closed = end ? Date.now() >= end.getTime() : null;
  const endLabel = end
    ? end.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", hour12: true })
    : null;


  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
      <Tile label="Books reported" hint="A book that did not report is never counted as missing anything.">
        <b className="text-lg font-bold">{loading ? "…" : `${reported} of 4`}</b>
        {!loading && silent.length > 0 && (
          <span className="block text-xs text-status-warning truncate">No data: {silent.join(", ")}</span>
        )}
      </Tile>

      <Tile label="Odoo window" hint="Odoo's record of a day is its postings from 3pm that day to 3pm on the next day the warehouse opens.">
        {loading || closed === null ? (
          <span className="text-text-muted">{loading ? "…" : "3pm to 3pm"}</span>
        ) : closed ? (
          <>
            <b className="text-lg font-bold text-success">Closed</b>
            <span className="block text-xs text-text-muted">at {endLabel}</span>
          </>
        ) : (
          <>
            <b className="text-lg font-bold text-status-warning">Still open</b>
            <span className="block text-xs text-text-muted">until {endLabel} — Odoo figures will rise</span>
          </>
        )}
      </Tile>

      <Tile label="Open variances">
        <button
          onClick={() => onOpenList({ bucket: "REAL", status: "open", title: "Open variances" })}
          className="text-lg font-bold text-danger hover:underline cursor-pointer"
          title="Open the variances awaiting action"
        >
          {statFigure(loading, error, agg?.openReal)}
        </button>
        <span className="flex flex-wrap gap-x-2 text-xs text-text-muted">
          {(agg?.high ?? 0) > 0 && <span className="text-danger">{agg?.high} urgent</span>}
          {(agg?.pendingApprovalReal ?? 0) > 0 && (
            <button
              onClick={() => onOpenList({ bucket: "REAL", status: "pending_approval", title: "Awaiting your approval" })}
              className="text-accent hover:underline cursor-pointer"
            >
              {agg?.pendingApprovalReal} awaiting approval
            </button>
          )}
          <button
            onClick={() => onOpenList({ bucket: "REAL", status: "closed", title: "Closed variances" })}
            className="hover:underline cursor-pointer"
          >
            {agg?.closedReal ?? 0} closed
          </button>
          {(agg?.pendingListReal ?? 0) > 0 && (
            <Link href="/pending-list" className="text-status-warning hover:underline">
              {agg?.pendingListReal} on pending list
            </Link>
          )}
        </span>
      </Tile>

      <Tile label="Traced">
        <span className="text-xs text-text-secondary">{rateCaption(agg)}</span>
        {(agg?.infoBucket ?? 0) > 0 && (
          <button
            onClick={() => onOpenList({ bucket: "INFO", status: "ALL", title: "Checked — no action needed" })}
            className="block text-xs text-text-muted hover:underline cursor-pointer text-left"
            title="Late Odoo postings, barcode typos, paperwork written a day either side"
          >
            {agg?.infoBucket} checked, no action needed
          </button>
        )}
      </Tile>
    </div>
  );
}
