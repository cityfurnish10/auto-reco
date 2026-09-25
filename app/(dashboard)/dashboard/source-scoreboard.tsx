// What each of the four books counted for the day, in and out.
//
// WHY THIS EXISTS. The dashboard could tell you about one unit at a time and
// nothing at all about the day as a whole. The first question anybody asks of a
// reconciliation — "do the four counts even agree?" — took opening the digest
// email or querying run_city_stats by hand, while the engine had been computing
// and storing exactly these figures on every run since migration 0012.
//
// It replaced the three KPI tiles. Those tiles answered "how much is on my
// list", which the one-line strip above this now answers in a tenth of the
// height; this answers "did the four records of today's movements line up",
// which nothing answered.
//
// THE RULE THIS SCREEN EXISTS TO HONOUR. A source that did not report is never
// shown as a zero. A Metabase outage and a genuinely quiet gate both count 0,
// and reading the first as the second is how an outage becomes a day that looks
// clean. `reported` is carried separately for exactly this, and a source that
// did not report renders as "no data" with no numbers at all.

"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/icon";
import { Modal } from "@/components/modal";
import { ErrorState } from "@/components/error-state";
import type { CityAgg, SourceCount } from "@/lib/hooks/use-dashboard-data";
import { SOURCE_NAME } from "@/lib/ui/source-names";

/** The four books, in the order the warehouse meets them. */
const SOURCES = [
  {
    key: "gate" as const,
    label: SOURCE_NAME.gate,
    hint: "What the guard recorded at the gate — the only source that was physically present when the goods crossed.",
  },
  {
    key: "sheet" as const,
    label: SOURCE_NAME.sheet,
    hint: "The warehouse team's own handwritten record of the day.",
  },
  {
    key: "dt" as const,
    label: SOURCE_NAME.dt,
    hint: "What the delivery agents' app recorded against their tasks.",
  },
  {
    key: "odoo" as const,
    label: SOURCE_NAME.odoo,
    hint: "Stock movements posted in Odoo for this date. Odoo is posted after the fact, so it is routinely the last to fill in — measured at Delhi, an outward posting lands about 26 hours after the goods leave.",
  },
];

interface Props {
  agg: CityAgg | null;
  /** City name, or "ALL". Only used to phrase the caption. */
  city: string;
  loading: boolean;
  /** The day these figures describe, for the caption. */
  businessDate?: string;
  /**
   * What that date MEANS (migration 0049). From 13 Sep 2026 a day is the
   * calendar day; before, 15:00 to 15:00. Taken from the run rather than
   * worked out here, because it is a fact about what the run did.
   */
  dayDefinition?: "calendar" | "business_15";
}

/** Which cell a manager clicked: one source, one direction (or both). */
interface OpenCell {
  source: "gate" | "sheet" | "dt" | "odoo";
  direction: "IN" | "OUT" | "BOTH";
  label: string;
  /** The figure that was clicked, so the modal can reconcile itself to it. */
  figure: number;
}

/** The stored source code each screen name maps to — see lib/ui/source-names. */
const CODE: Record<OpenCell["source"], string> = {
  gate: "PHYSICAL",
  sheet: "SHEET",
  dt: "DT",
  odoo: "ODOO",
};

export default function SourceScoreboard({ agg, city, loading, businessDate, dayDefinition }: Props) {
  const [cell, setCell] = useState<OpenCell | null>(null);
  const all = city === "ALL";
  const rows = SOURCES.map((s) => ({ ...s, count: agg?.sources?.[s.key] }));
  const silent = rows.filter((r) => r.count && !r.count.reported);
  // The spread across the sources that DID report, per direction. Two books
  // never match to the unit — each writes at a different moment — so the number
  // worth showing is the size of the disagreement, not whether one exists.
  // Across cities every row shows a figure (a gap only makes it partial), so
  // every row is comparable; on one city a source with no data has no number to
  // compare and must not drag the spread to look like a disagreement.
  const reporting = rows
    .map((r) => r.count)
    .filter((c): c is SourceCount => !!c && (c.reported || all));
  const spread = (dir: "in" | "out") => {
    if (reporting.length < 2) return null;
    const vals = reporting.map((c) => c[dir]);
    return Math.max(...vals) - Math.min(...vals);
  };
  // Three states per book, and they must not collapse into two: still
  // loading, did not report, and reported a figure (including a real zero).
  // ALL CITIES sums five warehouses; a city without data makes the total
  // PARTIAL there rather than blanking real scans elsewhere. On one city a
  // gap makes the figure unknown.
  const cols = rows.map((r) => {
    const c = r.count;
    const gap = !!c && !c.reported;
    return {
      ...r,
      unread: loading || !c,
      down: gap && !all,
      partial: gap && all,
      dropped: (c?.notDone?.in ?? 0) + (c?.notDone?.out ?? 0),
    };
  });
  const inSpread = spread("in");
  const outSpread = spread("out");

  return (
    <div className="card overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-surface-elevated flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-headline text-base text-text-primary">
          What each source counted{city === "ALL" ? " · all cities" : ` · ${city}`}
        </h3>
        <p className="text-xs text-text-muted">
          {businessDate ? (
            <>
              business date <b className="text-text-secondary">{businessDate}</b> ·{" "}
              {/* A run from before 0049 carries no stamp; every such run used
                  the 15:00 rule, so that is the right fallback. */}
              {dayDefinition === "calendar"
                ? "calendar day · Odoo 3pm to 3pm, past any week-off"
                : "3pm to 3pm"}
            </>
          ) : (
            "movements recorded for the day"
          )}
        </p>
      </div>

      {/* Sources across, directions down (transposed 18 Sep 2026 at the
          owner's request): the four books sit side by side, so reading a row
          left to right IS the comparison. */}
      <div className="overflow-x-auto">
        <table className="table-clean">
          <thead>
            <tr>
              <th className="min-w-[90px]"></th>
              {cols.map((r) => (
                <th key={r.key} className={`text-right min-w-[130px] align-bottom ${r.down ? "opacity-60" : ""}`}>
                  <span className="normal-case" title={r.hint}>{r.label}</span>
                  {r.down && (
                    <span className="badge badge-suppressed uppercase ml-2" title="This source did not report for this city and day — a connector failure, a gate that never synced, or a sheet not filed yet. The blanks are unknown, not zero.">
                      No data
                    </span>
                  )}
                  {r.partial && (
                    <span className="badge badge-suppressed uppercase ml-2" title="At least one city has no figure from this source for this day, so the totals beside it cover only the cities that did report. Open a single city tab to see which.">
                      Partial
                    </span>
                  )}
                  {/* WHY THE SHEET CAN BE SMALLER. Rows its own outcome column
                      marks "Not Delivered" are not movements and are left out —
                      invisible until somebody counted the tab by hand and found
                      91 where the board said 78. */}
                  {!r.unread && !r.down && r.dropped > 0 && (
                    <span
                      className="block text-[11px] font-normal normal-case tracking-normal text-text-muted"
                      title="Rows the sheet itself marks as not delivered or cancelled. They are not movements, so they are not counted here — this is the difference between the sheet's row count and the figure below it."
                    >
                      {r.dropped} not delivered
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(["IN", "OUT", "BOTH"] as const).map((dir) => (
              <tr key={dir} className={dir === "BOTH" ? "border-t-2 border-border" : undefined}>
                <td className={dir === "BOTH" ? "text-text-muted" : "text-text-primary font-medium"}>
                  {dir === "IN" ? "Inward" : dir === "OUT" ? "Outward" : "Total"}
                </td>
                {/* EVERY FIGURE OPENS ITS OWN ROWS. A count on its own can
                    only be trusted or doubted; the rows behind it can be
                    checked. */}
                {cols.map((r) => {
                  const c = r.count;
                  const n = !c ? 0 : dir === "IN" ? c.in : dir === "OUT" ? c.out : c.in + c.out;
                  const side = dir === "IN" ? "inward" : dir === "OUT" ? "outward" : "both ways";
                  return (
                    <Cell
                      key={r.key}
                      muted={dir === "BOTH"}
                      suffix={dir === "BOTH" && r.partial && !r.unread ? "+" : undefined}
                      figure={r.unread ? null : r.down ? "—" : n}
                      held={r.unread || r.down ? null : heldFor(c, dir)}
                      onOpen={() => setCell({ source: r.key, direction: dir, label: `${r.label} · ${side}`, figure: n })}
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="px-4 py-2.5 border-t border-border text-xs text-text-muted flex flex-wrap items-center gap-x-4 gap-y-1">
        {loading ? (
          "Loading…"
        ) : silent.length > 0 && !all ? (
          <span className="text-status-warning flex items-center gap-1.5">
            <Icon name="warning" size={14} />
            {silent.map((s) => s.label).join(", ")} did not report — this day cannot be judged
            complete
          </span>
        ) : silent.length > 0 ? (
          <span className="text-status-warning flex items-center gap-1.5">
            <Icon name="warning" size={14} />
            {silent
              .map((s) => `${s.label} has nothing from ${
                s.count?.missing?.length ? s.count.missing.map(titleCity).join(", ") : "at least one city"
              }`)
              .join(" · ")}
            {" "}— those totals cover only the cities that did report.
          </span>
        ) : inSpread !== null && outSpread !== null ? (
          <span>
            Widest gap between the books: <b className="text-text-secondary">{inSpread} inward</b>,{" "}
            <b className="text-text-secondary">{outSpread} outward</b>. The four never match to the
            unit — each is written at a different moment — so the list below is where the real
            disagreements are named.
          </span>
        ) : (
          "Not enough sources reported to compare."
        )}
      </div>

      {cell && businessDate && (
        <SourceRowsModal
          cell={cell}
          date={businessDate}
          city={city}
          onClose={() => setCell(null)}
        />
      )}
    </div>
  );
}

/**
 * One figure in the table, as a button.
 *
 * A dash or a loading ellipsis is NOT clickable: there is nothing behind a
 * figure that was never read, and a button that opens an empty modal teaches
 * people the modal is broken rather than that the source was silent.
 */
/**
 * What the source itself held for a direction, and why our figure differs.
 *
 * Asked for 25 Sep 2026: "most of out/in movement is not matching the
 * individual sources, the way we look at it". Every figure on this board had
 * survived a rule, and no rule said so — Delhi's 22 Sep showed 104 outward
 * against an ops sheet holding 105 rows, and 70 inward against 78.
 */
function heldFor(c: SourceCount | undefined, dir: "IN" | "OUT" | "BOTH"): HeldSummary | null {
  const h = c?.held;
  if (!h) return null;
  const pick = (d: "in" | "out") => h[d];
  const parts = dir === "BOTH" ? [pick("in"), pick("out")] : [pick(dir === "IN" ? "in" : "out")];
  const sum = (f: "rows" | "units" | "notDelivered" | "notAUnit") =>
    parts.reduce((a, p) => a + (p?.[f] ?? 0), 0);
  return { rows: sum("rows"), units: sum("units"), notDelivered: sum("notDelivered"), notAUnit: sum("notAUnit") };
}
interface HeldSummary { rows: number; units: number; notDelivered: number; notAUnit: number }

/** The sentence under a figure that does not equal what the source holds. */
function heldCaption(figure: number, h: HeldSummary): { line: string; why: string } | null {
  if (!h.rows || h.rows === figure) return null;
  // FACTS ONLY. An earlier draft named the reasons here from the row text and
  // could disagree with the engine, which is the very thing this is meant to
  // cure. The three numbers are read from the run; the rows behind them are one
  // click away, each marked counted or not.
  const dupes = h.rows - h.units;
  return {
    line: `of ${h.rows} in the source`,
    why:
      `The source handed over ${h.rows} row${h.rows === 1 ? "" : "s"} here` +
      (dupes > 0 ? `, covering ${h.units} unit${h.units === 1 ? "" : "s"} (${dupes} written more than once)` : "") +
      `. ${figure} counted. Open the cell to see every row, with the uncounted ones marked.`,
  };
}

function Cell({ figure, onOpen, muted, suffix, held }: {
  figure: number | string | null;
  onOpen: () => void;
  muted?: boolean;
  suffix?: string;
  held?: HeldSummary | null;
}) {
  const tone = muted ? "text-text-secondary" : "font-semibold text-text-primary";
  if (figure === null) return <td className={`text-right ${tone}`}>…</td>;
  if (typeof figure === "string") return <td className={`text-right ${tone}`}>{figure}</td>;
  // THE WHOLE CELL IS THE TARGET. A button that fills a table cell by padding
  // does not, reliably: the table's own cell padding wins over a utility and
  // leaves a target the size of the digits (reported 18 Sep 2026). So the cell
  // takes the click, and the button inside is only there for the keyboard —
  // Enter on it bubbles to the same handler.
  return (
    <td
      onClick={onOpen}
      className={`text-right cursor-pointer hover:bg-surface-elevated hover:text-accent group ${tone}`}
      title="Open the rows behind this figure, exactly as the source sent them"
    >
      <button type="button" className="group-hover:underline">
        {figure}
        {suffix && <span className="text-text-disabled">{suffix}</span>}
      </button>
      {(() => {
        const cap = held ? heldCaption(figure, held) : null;
        return cap ? (
          <span className="block text-[11px] font-normal text-text-muted" title={cap.why}>{cap.line}</span>
        ) : null;
      })()}
    </td>
  );
}

/** "HYDERABAD" → "Hyderabad", for a sentence rather than a code. */
const titleCity = (c: string) => c.charAt(0) + c.slice(1).toLowerCase();

interface RawRow {
  /** False = in the source, not behind the figure. Null = ledger unreadable. */
  counted?: boolean | null;
  barcodeAsWritten: string;
  direction: string;
  status: string | null;
  jobType: string | null;
  soNumber: string | null;
  ticketId: string | null;
  customer: string | null;
  product: string | null;
  recordedAt: string | null;
  /** Details found afterwards from Odoo/DT, not asserted by this source. */
  lookedUp?: boolean;
  /** The lookup settled on the unit's LAST task, not this movement's. */
  lastKnown?: boolean;
  /** Odoo order transfer (Reference# OT-…): listed, never counted. */
  orderTransferRef?: string | null;
}

/** The rows behind one figure, exactly as that book sent them. */
function SourceRowsModal({ cell, date, city, onClose }: {
  cell: OpenCell;
  date: string;
  city: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<RawRow[] | null>(null);
  const [pruned, setPruned] = useState(false);
  const [capped, setCapped] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const q = new URLSearchParams({ date, source: CODE[cell.source] });
    if (cell.direction !== "BOTH") q.set("direction", cell.direction);
    if (city !== "ALL") q.set("city", city);
    fetch(`/api/source-rows?${q}`, { credentials: "same-origin" })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (j.error) setError(String(j.error));
        else { setRows(j.rows ?? []); setPruned(!!j.pruned); setCapped(!!j.capped); }
      })
      .catch(() => { if (alive) setError("Could not reach the server."); });
    return () => { alive = false; };
  }, [cell, date, city]);

  const istTime = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata", day: "2-digit", month: "short",
          hour: "2-digit", minute: "2-digit", hour12: false,
        })
      : "—";

  return (
    <Modal open onClose={onClose} size="xl" icon="fact_check"
      title={`${cell.label} · ${date}`}
      subtitle="The rows exactly as this source sent them — before matching, folding or de-duplicating. This is why the figure is what it is.">
      {error && <ErrorState what="these rows" detail={error} onRetry={() => location.reload()} compact />}
      {!rows && !error && <p className="text-sm text-text-muted">Loading…</p>}
      {rows && rows.length === 0 && (
        <p className="text-sm text-text-muted">
          {pruned
            ? "No rows kept for this day. The raw feed is retained for about six weeks, so an older date shows nothing here — which is not the same as the source having reported nothing."
            : "This source sent no rows for this day."}
        </p>
      )}
      {rows && rows.length > 0 && (
        <>
          {cell.source === "gate" && (
            <p className="text-xs text-text-muted mb-2">
              The guard records only the barcode and the time. Product, customer, order and ticket
              are looked up afterwards from Odoo and shown in italics.
            </p>
          )}
          <p className="text-sm text-text-muted mb-3">
            {rows.length} row{rows.length === 1 ? "" : "s"}
            {capped && <span className="text-status-warning"> · showing the first 1,000 only</span>}
            {/* THE ONE CELL THAT LEGITIMATELY DIFFERS. The sheet sends rows its
                own outcome column marks "Not Delivered"; those are not
                movements and are not counted. Saying so here is the difference
                between a modal that explains the figure and one that appears to
                contradict it. */}
            {rows.length !== cell.figure && (
              <span>
                {" · "}the board counts <b className="text-text-primary">{cell.figure}</b> of these.
                {" "}The ones it does not are marked <b className="text-text-primary">not counted</b> —
                {" "}order transfers, rows the source marked not delivered, lines with no barcode,
                {" "}or a unit written more than once.
              </span>
            )}
          </p>
          <div className="overflow-x-auto border border-border rounded-control">
            <table className="w-full text-sm border-collapse">
              <thead className="bg-surface-elevated">
                <tr>
                  {["Way", "Barcode", "Product", "Customer", "SO", "Ticket", "Job type", "Outcome", "Recorded at"].map((h) => (
                    <th key={h} className="text-left px-3 py-2 border border-border text-xs uppercase tracking-wide text-text-muted whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.barcodeAsWritten}-${i}`} className={`hover:bg-surface-elevated ${r.counted === false ? "opacity-60" : ""}`}>
                    <td className="px-3 py-1.5 border border-border whitespace-nowrap">
                      {/* THE ROW'S OWN ANSWER to "is this one of the N?" —
                          the join the modal never had. */}
                      {r.counted === false && (
                        <span className="badge badge-suppressed uppercase mr-2" title="This row is in the source but is not part of the figure on the board">
                          not counted
                        </span>
                      )}
                      {r.direction === "IN" ? "Inward" : "Outward"}
                    </td>
                    <td className="px-3 py-1.5 border border-border font-mono whitespace-nowrap">{r.barcodeAsWritten || "—"}</td>
                    <td className="px-3 py-1.5 border border-border">{r.product ?? "—"}</td>
                    <td className="px-3 py-1.5 border border-border">
                      {r.customer ? (
                        <span className={r.lookedUp ? "italic text-text-secondary" : undefined}
                          title={r.lookedUp ? (r.lastKnown ? "Looked up from Odoo — where this unit was LAST seen, not necessarily this movement" : "Looked up from Odoo against this movement — the guard records only the barcode") : undefined}>
                          {r.customer}{r.lookedUp && r.lastKnown && <span className="not-italic text-text-disabled"> (last known)</span>}
                        </span>
                      ) : "—"}
                    </td>
                    <td className="px-3 py-1.5 border border-border font-mono whitespace-nowrap">{r.soNumber ?? "—"}</td>
                    <td className="px-3 py-1.5 border border-border font-mono whitespace-nowrap">{r.ticketId ?? "—"}</td>
                    <td className="px-3 py-1.5 border border-border whitespace-nowrap">{r.jobType ?? "—"}</td>
                    {/* Only the sheet carries an outcome (invariant 3); the
                        other three hard-code "done" because each filters to
                        completed rows upstream. Shown raw so a "Not Delivered"
                        is visible as the sheet wrote it. */}
                    <td className="px-3 py-1.5 border border-border whitespace-nowrap">
                      {r.orderTransferRef ? (
                        <span className="badge badge-medium" title={`Order transfer ${r.orderTransferRef} — not a movement, not in the figure; raised as an OT CASE to map by hand`}>
                          OT CASE
                        </span>
                      ) : (r.status ?? "—")}
                    </td>
                    <td className="px-3 py-1.5 border border-border whitespace-nowrap tabular-nums text-xs text-text-muted">{istTime(r.recordedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
