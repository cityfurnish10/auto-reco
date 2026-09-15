"use client";

// Items in transit — outward units the gate or DT saw leave, whose Odoo Out is
// reserved against the sale order but not yet validated (variance
// ODOO_OUT_PENDING, decided 14 Sep 2026).
//
// A CARD with the key numbers, opening the full list in a modal (asked for the
// same evening — a table above the tiles pushed the day's losses down the page).
// Kept apart from the chase list because these are not losses: the unit is on
// its way, and what it needs is the Odoo Out validated once delivered.

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/icon";
import { Modal } from "@/components/modal";
import { ErrorState } from "@/components/error-state";
import { useVariances, type VarianceFilters } from "@/lib/hooks/use-dashboard-data";
import { VARIANCE } from "@/lib/engine/variance-names";
import { shownBarcode } from "@/lib/ui/barcode-display";
import type { VarianceDB } from "@/lib/db/schema";
import type { City } from "@/lib/sample-data";

const PAGE = 200;

/** What the gate looked up for a unit, for display only — never the engine's. */
interface GateDetail {
  customer: string | null;
  soNumber: string | null;
  ticketId: string | null;
  product: string | null;
  /** False = the unit's LAST known task, not this movement's. Say so. */
  matched: boolean;
}

const distinct = (rows: VarianceDB[], pick: (v: VarianceDB) => string | null | undefined) =>
  new Set(rows.map((v) => (pick(v) ?? "").trim().toLowerCase()).filter(Boolean)).size;

export default function InTransitSection({ city, date, onOpen }: {
  city: City | "ALL";
  /** "" = the latest run, as elsewhere on the dashboard. */
  date: string;
  /** Open one row's variance detail (stacked above the list). */
  onOpen: (v: VarianceDB) => void;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const filters: VarianceFilters = useMemo(() => ({
    city, date: date || undefined, bucket: "INFO", variance: VARIANCE.ODOO_OUT_PENDING,
    status: "ACTIVE", sort: "date", dir: "desc", page, pageSize: PAGE,
  }), [city, date, page]);
  const { rows, total, totalPages, loading, error, refetch } = useVariances(filters);

  // THE CUSTOMER THE GATE LOOKED UP, for rows that have none of their own.
  //
  // A unit whose only floor evidence is a gate scan reaches here blank: the
  // guard's phone records a barcode and nothing else, and the details are found
  // afterwards and kept in columns the engine deliberately never reads (see
  // app/api/gate/unit-details). Delhi only, because it is the only city whose
  // floor record comes from the app.
  //
  // Fetched for display and never merged into the row: these came from Odoo and
  // DT, so showing them as if the gate had asserted them is the exact confusion
  // the separation exists to prevent. Hence the marker in the cell.
  const [gateDetails, setGateDetails] = useState<Record<string, GateDetail>>({});
  const missing = useMemo(
    () => rows.filter((v) => !v.customer).map((v) => v.barcode_display || v.barcode).filter(Boolean),
    [rows]
  );
  useEffect(() => {
    if (missing.length === 0) return;
    let alive = true;
    fetch("/api/gate/unit-details", {
      method: "POST", headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ barcodes: missing, city: city === "ALL" ? undefined : city, direction: "OUT" }),
    })
      .then((r) => r.json())
      .then((j) => { if (alive) setGateDetails(j.details ?? {}); })
      // A failed lookup leaves the cells as they were. It is a nicety, and it
      // must never take the list down with it.
      .catch(() => { if (alive) setGateDetails({}); });
    return () => { alive = false; };
  }, [missing, city]);

  const lookedUp = (v: VarianceDB) =>
    gateDetails[(v.barcode_display || "").toUpperCase()] ?? gateDetails[(v.barcode || "").toUpperCase()] ?? null;

  // Nothing in transit is the normal state for most cities and days; no empty card.
  if (!loading && !error && total === 0) return null;

  // Orders, customers and the city split are counted over what was loaded —
  // the whole set unless a day ever holds more than 200, which the card says.
  const complete = total <= PAGE;
  const byCity = [...rows.reduce((m, v) => m.set(v.city, (m.get(v.city) ?? 0) + 1), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1]);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} disabled={loading && total === 0}
        className="card card-hover w-full text-left p-4 flex flex-wrap items-center gap-x-8 gap-y-3 cursor-pointer group"
        title="Open the items in transit">
        <div className="flex items-center gap-3 min-w-[14rem]">
          <span className="w-10 h-10 rounded-control bg-surface-elevated grid place-items-center text-text-secondary">
            <Icon name="local_shipping" size={20} />
          </span>
          <div>
            <p className="kpi-label group-hover:underline">Items in transit</p>
            <p className="text-xs text-text-muted">Left the warehouse · Odoo Out not yet validated · not a loss</p>
          </div>
        </div>
        {error ? (
          <span className="text-sm text-text-muted">Could not load</span>
        ) : (
          <>
            <Figure label="Items" value={loading ? "—" : total} />
            <Figure label="Orders" value={loading ? "—" : `${distinct(rows, (v) => v.so_number)}${complete ? "" : "+"}`} />
            <Figure label="Customers" value={loading ? "—" : `${distinct(rows, (v) => v.customer)}${complete ? "" : "+"}`} />
            {city === "ALL" && !loading && byCity.length > 1 && (
              <span className="text-xs text-text-muted">
                {byCity.map(([c, n]) => `${c} ${n}`).join(" · ")}
              </span>
            )}
          </>
        )}
        <Icon name="chevron_right" size={18} className="ml-auto text-text-muted" />
      </button>

      {open && (
        <Modal open onClose={() => { setOpen(false); setPage(1); }} size="xl" icon="local_shipping"
          title={`Items in transit · ${total}`}
          subtitle="Seen leaving by the gate or DT, with the Odoo Out reserved against the order but not yet validated. Validate the Out once delivered.">
          {error && <ErrorState what="items in transit" detail={error} onRetry={refetch} compact />}
          {loading && <p className="text-sm text-text-muted">Loading…</p>}
          {!loading && !error && (
            <div className="overflow-x-auto border border-border rounded-control">
              <table className="w-full text-sm border-collapse">
                <thead className="bg-surface-elevated">
                  <tr>
                    {["City", "Barcode", "Product", "Customer", "SO", "Ticket", "Date"].map((h) => (
                      <th key={h} className="text-left px-3 py-2 border border-border text-xs uppercase tracking-wide text-text-muted whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((v) => (
                    <tr key={v.id} onClick={() => onOpen(v)} className="cursor-pointer hover:bg-surface-elevated">
                      <td className="px-3 py-1.5 border border-border whitespace-nowrap">{v.city}</td>
                      <td className="px-3 py-1.5 border border-border font-mono whitespace-nowrap">{shownBarcode(v)}</td>
                      <td className="px-3 py-1.5 border border-border">{v.product ?? lookedUp(v)?.product ?? "—"}</td>
                      <td className="px-3 py-1.5 border border-border">
                        <Cell own={v.customer} gate={lookedUp(v)?.customer} matched={lookedUp(v)?.matched} />
                      </td>
                      <td className="px-3 py-1.5 border border-border font-mono whitespace-nowrap">
                        <Cell own={v.so_number} gate={lookedUp(v)?.soNumber} matched={lookedUp(v)?.matched} />
                      </td>
                      <td className="px-3 py-1.5 border border-border font-mono whitespace-nowrap">
                        <Cell own={v.ticket_id} gate={lookedUp(v)?.ticketId} matched={lookedUp(v)?.matched} />
                      </td>
                      <td className="px-3 py-1.5 border border-border whitespace-nowrap tabular-nums">{String(v.business_date).slice(0, 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {totalPages > 1 && (
            <div className="flex items-center justify-end gap-2 mt-3 text-sm">
              <button className="btn btn-compact btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
              <span className="text-text-muted">Page {page} of {totalPages}</span>
              <button className="btn btn-compact btn-secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

/**
 * One detail cell: the row's own value, or the gate's looked-up one.
 *
 * The two are drawn differently on purpose. The row's value is what the books
 * being reconciled actually say. The looked-up one came from Odoo afterwards
 * and is a hint about the unit, not evidence about the movement — and when the
 * lookup fell back to the unit's LAST known task, it may not even be about
 * today. Presenting the two identically would quietly turn a hint into a fact.
 */
function Cell({ own, gate, matched }: { own?: string | null; gate?: string | null; matched?: boolean }) {
  if (own) return <>{own}</>;
  if (!gate) return <>—</>;
  return (
    <span
      className="text-text-secondary italic"
      title={matched
        ? "Not in the books being compared — looked up from Odoo against this movement"
        : "Not in the books being compared — this is where the unit was LAST seen, not necessarily today"}
    >
      {gate}
      {!matched && <span className="text-text-disabled not-italic"> (last known)</span>}
    </span>
  );
}

function Figure({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-text-muted">{label}</p>
      <p className="text-2xl font-semibold text-text-primary tabular-nums leading-tight">{value}</p>
    </div>
  );
}
