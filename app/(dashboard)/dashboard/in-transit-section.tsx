"use client";

// Items in transit — outward units the gate or DT saw leave, whose Odoo Out is
// reserved against the sale order but not yet validated (variance
// ODOO_OUT_PENDING, decided 14 Sep 2026).
//
// A CARD with the key numbers, opening the full list in a modal (asked for the
// same evening — a table above the tiles pushed the day's losses down the page).
// Kept apart from the chase list because these are not losses: the unit is on
// its way, and what it needs is the Odoo Out validated once delivered.

import { useMemo, useState } from "react";
import { Icon } from "@/components/icon";
import { Modal } from "@/components/modal";
import { ErrorState } from "@/components/error-state";
import { useVariances, type VarianceFilters } from "@/lib/hooks/use-dashboard-data";
import { VARIANCE } from "@/lib/engine/variance-names";
import { shownBarcode } from "@/lib/ui/barcode-display";
import type { VarianceDB } from "@/lib/db/schema";
import type { City } from "@/lib/sample-data";

const PAGE = 200;

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
                      <td className="px-3 py-1.5 border border-border">{v.product ?? "—"}</td>
                      <td className="px-3 py-1.5 border border-border">{v.customer ?? "—"}</td>
                      <td className="px-3 py-1.5 border border-border font-mono whitespace-nowrap">{v.so_number ?? "—"}</td>
                      <td className="px-3 py-1.5 border border-border font-mono whitespace-nowrap">{v.ticket_id ?? "—"}</td>
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

function Figure({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-text-muted">{label}</p>
      <p className="text-2xl font-semibold text-text-primary tabular-nums leading-tight">{value}</p>
    </div>
  );
}
