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

import { useEffect, useState } from "react";
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
  kind: "all" | "allMatched" | "matched" | "notMatched";
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
      <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-4 gap-3">
        {BOOKS.map((book) => {
          const c = t?.[book];
          const others = BOOKS.filter((o) => o !== book);
          const open = (p: Omit<Pick, "truth">) => businessDate && setPick({ truth: book, ...p });
          return (
            <div key={book} className="card p-4 flex flex-col gap-2">
              <div>
                <p className="text-[11px] uppercase tracking-wider text-text-muted">Source of truth</p>
                <h4 className="font-headline text-base text-text-primary">{NAME[book]}</h4>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wide text-text-muted">
                    <th className="text-left font-normal py-1"></th>
                    <th className="text-right font-normal py-1 px-2">Inward</th>
                    <th className="text-right font-normal py-1 px-2">Outward</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-border">
                    <td className="py-0.5 text-text-secondary">Has</td>
                    {(["IN", "OUT"] as Dir[]).map((d) => (
                      <td key={d}><Fig loading={loading} n={c?.[d].saw} onClick={() => open({ direction: d, kind: "all", label: `${NAME[book]} · ${d === "IN" ? "inward" : "outward"}` })} /></td>
                    ))}
                  </tr>
                  <tr className="border-t border-border">
                    <td className="py-0.5 text-text-secondary">All four agree</td>
                    {(["IN", "OUT"] as Dir[]).map((d) => (
                      <td key={d}><Fig loading={loading} tone="ok" n={c?.[d].allMatched} onClick={() => open({ direction: d, kind: "allMatched", label: `${NAME[book]} · all four agree · ${d === "IN" ? "inward" : "outward"}` })} /></td>
                    ))}
                  </tr>
                  {others.map((o) => (
                    <tr key={o} className="border-t border-border">
                      <td className="py-0.5 text-text-secondary">
                        vs {NAME[o]}
                        <span className="block text-[11px] text-text-muted">matched · not matched</span>
                      </td>
                      {(["IN", "OUT"] as Dir[]).map((d) => {
                        const v = c?.[d].vs[o];
                        const side = d === "IN" ? "inward" : "outward";
                        return (
                          <td key={d} className="align-top">
                            <div className="flex justify-end">
                              <span className="w-1/2"><Fig loading={loading} tone="ok" n={v?.matched} onClick={() => open({ direction: d, kind: "matched", vs: o, label: `${NAME[book]} and ${NAME[o]} both have · ${side}` })} /></span>
                              <span className="w-1/2"><Fig loading={loading} tone="bad" n={v?.notMatched} onClick={() => open({ direction: d, kind: "notMatched", vs: o, label: `${NAME[book]} has, ${NAME[o]} does not · ${side}` })} /></span>
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
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

/** One clickable figure. A zero is shown but opens nothing. */
function Fig({ n, onClick, tone, loading }: {
  n: number | undefined; onClick: () => void; tone?: "ok" | "bad"; loading: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading || !n}
      className={`tabular-nums text-right w-full px-2 py-1 rounded-control hover:bg-surface-elevated disabled:hover:bg-transparent disabled:cursor-default cursor-pointer ${
        tone === "bad" && n ? "text-danger font-semibold" : tone === "ok" ? "text-success" : "text-text-primary font-semibold"
      }`}
    >
      {loading ? "…" : n ?? 0}
    </button>
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
