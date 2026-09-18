"use client";

// Section 3 — do the books agree? Each book in turn as the source of truth.
//
// Owner's design, 18 Sep 2026, after deciding that no single book is the
// anchor and all four are cross-verified. Four cards, one per book: of the
// units THAT book has, how many all four agree on, and how many each of the
// other three matches or misses — inward and outward apart, because they are
// different movements with different books behind them.
//
// Units, not rows, from the movement ledger — one per barcode per direction.
// Odoo is counted on its own 3pm window, the same rule as the source table in
// section 2, so each card's "has" figure ties to that table.

import { useEffect, useState, type ReactNode } from "react";
import { Modal } from "@/components/modal";
import { ErrorState } from "@/components/error-state";
import { SOURCE_NAME } from "@/lib/ui/source-names";
import type { CityAgg, TruthSource } from "@/lib/hooks/use-dashboard-data";

const BOOKS: TruthSource[] = ["gate", "sheet", "dt", "odoo"];
const NAME: Record<TruthSource, string> = {
  gate: SOURCE_NAME.gate, sheet: SOURCE_NAME.sheet, dt: SOURCE_NAME.dt, odoo: SOURCE_NAME.odoo,
};
type Dir = "IN" | "OUT";

/** What was clicked: which book is the truth, and which slice of its units. */
interface Pick {
  truth: TruthSource;
  direction: Dir;
  kind: "all" | "allMatched" | "notAll" | "matched" | "notMatched";
  vs?: TruthSource;
  label: string;
}

export default function SourceTruthCards({ agg, city, loading, businessDate }: {
  agg: CityAgg | null;
  city: string;
  loading: boolean;
  businessDate?: string;
}) {
  const [pick, setPick] = useState<Pick | null>(null);
  const t = agg?.truth;

  return (
    <>
      {/* Redrawn 18 Sep 2026 ("cleaner, or try a visual"): the table of
          matched · not matched pairs read as a wall of numbers. Each line is
          now one bar — green the units the other book also has, red the ones
          it lacks — so the weak pairing is visible before a figure is read. */}
      <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-4 gap-3">
        {BOOKS.map((book) => {
          const c = t?.[book];
          const others = BOOKS.filter((o) => o !== book);
          const open = (p: Omit<Pick, "truth">) => businessDate && setPick({ truth: book, ...p });
          const side = (d: Dir) => (d === "IN" ? "inward" : "outward");
          return (
            <div key={book} className="card p-4 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] uppercase tracking-wider text-text-muted">Source of truth</p>
                  <h4 className="font-headline text-base text-text-primary truncate">{NAME[book]}</h4>
                </div>
                <div className="flex gap-3 text-right shrink-0">
                  {(["IN", "OUT"] as Dir[]).map((d) => (
                    <button
                      key={d}
                      type="button"
                      disabled={loading || !c?.[d].saw}
                      onClick={() => open({ direction: d, kind: "all", label: `${NAME[book]} · ${side(d)}` })}
                      className="rounded-control px-1.5 hover:bg-surface-elevated disabled:hover:bg-transparent cursor-pointer disabled:cursor-default"
                      title={`Every ${side(d)} unit ${NAME[book]} has`}
                    >
                      <span className="block text-lg font-bold tabular-nums text-text-primary leading-tight">
                        {loading ? "…" : c?.[d].saw ?? 0}
                      </span>
                      <span className="block text-[11px] text-text-muted">{d === "IN" ? "In" : "Out"}</span>
                    </button>
                  ))}
                </div>
              </div>

              <Group title="All four agree">
                {(["IN", "OUT"] as Dir[]).map((d) => {
                  const saw = c?.[d].saw ?? 0;
                  const ok = c?.[d].allMatched ?? 0;
                  return (
                    <Bar key={d} dir={d} loading={loading} ok={ok} bad={Math.max(0, saw - ok)}
                      onOk={() => open({ direction: d, kind: "allMatched", label: `${NAME[book]} · all four agree · ${side(d)}` })}
                      onBad={() => open({ direction: d, kind: "notAll", label: `${NAME[book]} has, at least one other book does not · ${side(d)}` })} />
                  );
                })}
              </Group>

              {others.map((o) => (
                <Group key={o} title={`vs ${NAME[o]}`}>
                  {(["IN", "OUT"] as Dir[]).map((d) => {
                    const v = c?.[d].vs[o];
                    return (
                      <Bar key={d} dir={d} loading={loading} ok={v?.matched ?? 0} bad={v?.notMatched ?? 0}
                        onOk={() => open({ direction: d, kind: "matched", vs: o, label: `${NAME[book]} and ${NAME[o]} both have · ${side(d)}` })}
                        onBad={() => open({ direction: d, kind: "notMatched", vs: o, label: `${NAME[book]} has, ${NAME[o]} does not · ${side(d)}` })} />
                    );
                  })}
                </Group>
              ))}

              <p className="flex items-center gap-3 text-[11px] text-text-muted pt-1 border-t border-border">
                <span className="inline-flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-sm bg-success" /> matched</span>
                <span className="inline-flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-sm bg-danger" /> not matched</span>
                <span className="ml-auto">click a bar to see units</span>
              </p>
            </div>
          );
        })}
      </div>
      {pick && businessDate && (
        <TruthModal pick={pick} date={businessDate} city={city} onClose={() => setPick(null)} />
      )}
    </>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium text-text-secondary">{title}</p>
      {children}
    </div>
  );
}

/**
 * One direction's split: green = matched, red = not matched, widths in
 * proportion. Each half is its own button; an empty half opens nothing.
 * The figures sit beside the bar so it never has to be read by eye alone.
 */
function Bar({ dir, ok, bad, onOk, onBad, loading }: {
  dir: Dir; ok: number; bad: number; onOk: () => void; onBad: () => void; loading: boolean;
}) {
  const total = ok + bad;
  const pct = total ? Math.round((ok / total) * 100) : 0;
  return (
    <div className="grid grid-cols-[28px_1fr_auto] items-center gap-2 text-xs">
      <span className="text-text-muted">{dir === "IN" ? "In" : "Out"}</span>
      <div className="flex h-3 rounded-full overflow-hidden bg-surface-elevated" title={total ? `${pct}% matched` : "Nothing to compare"}>
        {!loading && ok > 0 && (
          <button type="button" onClick={onOk} style={{ width: `${(ok / total) * 100}%` }}
            className="bg-success hover:opacity-80 cursor-pointer" aria-label={`${ok} matched`} />
        )}
        {!loading && bad > 0 && (
          <button type="button" onClick={onBad} style={{ width: `${(bad / total) * 100}%` }}
            className="bg-danger hover:opacity-80 cursor-pointer" aria-label={`${bad} not matched`} />
        )}
      </div>
      <span className="tabular-nums whitespace-nowrap text-right min-w-[64px]">
        {loading ? "…" : (
          <>
            <button type="button" disabled={!ok} onClick={onOk} className="text-success hover:underline disabled:no-underline cursor-pointer disabled:cursor-default">{ok}</button>
            <span className="text-text-muted"> · </span>
            <button type="button" disabled={!bad} onClick={onBad} className={`${bad ? "text-danger font-semibold" : "text-text-muted"} hover:underline disabled:no-underline cursor-pointer disabled:cursor-default`}>{bad}</button>
          </>
        )}
      </span>
    </div>
  );
}

interface Row {
  barcodeDisplay: string;
  direction: string;
  jobType: string | null;
  soNumber: string | null;
  ticketId: string | null;
  customer: string | null;
  product: string | null;
  seenBy: string;
}

function TruthModal({ pick, date, city, onClose }: { pick: Pick; date: string; city: string; onClose: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [capped, setCapped] = useState(false);

  useEffect(() => {
    let alive = true;
    const q = new URLSearchParams({ truth: pick.truth, kind: pick.kind, direction: pick.direction, date });
    if (pick.vs) q.set("vs", pick.vs);
    if (city !== "ALL") q.set("city", city);
    fetch(`/api/anchored?${q}`, { credentials: "same-origin" })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (j.error) setError(String(j.error));
        else { setRows(j.rows ?? []); setCapped(!!j.capped); }
      })
      .catch(() => { if (alive) setError("Could not reach the server."); });
    return () => { alive = false; };
  }, [pick, date, city]);

  return (
    <Modal open onClose={onClose} size="xl" icon="fact_check" title={`${pick.label} · ${date}`}
      subtitle="One row per unit. 'Seen by' names every book that has it — the others do not.">
      {error && <ErrorState what="these units" detail={error} onRetry={() => location.reload()} compact />}
      {!rows && !error && <p className="text-sm text-text-muted">Loading…</p>}
      {rows && rows.length === 0 && <p className="text-sm text-text-muted">Nothing in this group for the day.</p>}
      {rows && rows.length > 0 && (
        <>
          <p className="text-sm text-text-muted mb-3">
            {rows.length} unit{rows.length === 1 ? "" : "s"}
            {capped && <span className="text-status-warning"> · showing the first 1,000 only</span>}
          </p>
          <div className="overflow-x-auto border border-border rounded-control">
            <table className="w-full text-sm border-collapse">
              <thead className="bg-surface-elevated">
                <tr>
                  {["Barcode", "Product", "Customer", "SO", "Ticket", "Job type", "Seen by"].map((h) => (
                    <th key={h} className="text-left px-3 py-2 border border-border text-xs uppercase tracking-wide text-text-muted whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.barcodeDisplay}-${i}`} className="hover:bg-surface-elevated">
                    <td className="px-3 py-1.5 border border-border font-mono whitespace-nowrap">{r.barcodeDisplay}</td>
                    <td className="px-3 py-1.5 border border-border">{r.product ?? "—"}</td>
                    <td className="px-3 py-1.5 border border-border">{r.customer ?? "—"}</td>
                    <td className="px-3 py-1.5 border border-border font-mono whitespace-nowrap">{r.soNumber ?? "—"}</td>
                    <td className="px-3 py-1.5 border border-border font-mono whitespace-nowrap">{r.ticketId ?? "—"}</td>
                    <td className="px-3 py-1.5 border border-border whitespace-nowrap">{r.jobType ?? "—"}</td>
                    <td className="px-3 py-1.5 border border-border text-xs text-text-muted">{r.seenBy}</td>
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
