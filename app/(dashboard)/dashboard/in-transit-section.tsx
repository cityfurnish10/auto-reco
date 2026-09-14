"use client";

// Items in transit — outward units the gate or DT saw leave, whose Odoo Out is
// reserved against the sale order but not yet validated (variance
// ODOO_OUT_PENDING, decided 14 Sep 2026).
//
// Its own section, ABOVE the chase list, because these are not losses: the unit
// is on its way. Mixed into the INFO rows they disappear; mixed into REAL they
// read as missing stock. What they need is the Odoo team validating the Out
// once the delivery is done, and a list they can work down is how that happens.

import { useMemo } from "react";
import { Icon } from "@/components/icon";
import { ErrorState } from "@/components/error-state";
import { useVariances, type VarianceFilters } from "@/lib/hooks/use-dashboard-data";
import { VARIANCE } from "@/lib/engine/variance-names";
import { shownBarcode } from "@/lib/ui/barcode-display";
import type { VarianceDB } from "@/lib/db/schema";
import type { City } from "@/lib/sample-data";

const SHOWN = 8;

export default function InTransitSection({ city, date, onOpen, onViewAll }: {
  city: City | "ALL";
  /** "" = the latest run, as elsewhere on the dashboard. */
  date: string;
  onOpen: (v: VarianceDB) => void;
  /** Narrow the main table to these rows. */
  onViewAll: () => void;
}) {
  const filters: VarianceFilters = useMemo(() => ({
    city, date: date || undefined, bucket: "INFO", variance: VARIANCE.ODOO_OUT_PENDING,
    status: "ACTIVE", sort: "date", dir: "desc", page: 1, pageSize: SHOWN,
  }), [city, date]);
  const { rows, total, loading, error, refetch } = useVariances(filters);

  // Nothing in transit is the normal state for most cities and days; say
  // nothing rather than add an empty box above the list people came for.
  if (!loading && !error && total === 0) return null;

  return (
    <section className="card p-4 border border-info/30">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <Icon name="local_shipping" size={18} />
        <h2 className="font-semibold text-text-primary">Items in transit</h2>
        {!loading && <span className="badge badge-info">{total}</span>}
        <span className="text-xs text-text-muted">
          Seen leaving by the gate or DT · Odoo Out reserved, not yet validated · not a loss
        </span>
        {total > SHOWN && (
          <button className="btn btn-compact btn-secondary ml-auto" onClick={onViewAll}>
            View all {total}
          </button>
        )}
      </div>
      {error && <ErrorState what="items in transit" detail={error} onRetry={refetch} compact />}
      {loading && <p className="text-sm text-text-muted">Loading…</p>}
      {!loading && !error && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                {["City", "Barcode", "Product", "Customer", "SO", "Ticket", "Date"].map((h) => (
                  <th key={h} className="text-left px-3 py-1.5 text-xs uppercase tracking-wide text-text-muted whitespace-nowrap border-b border-border">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id} onClick={() => onOpen(v)} className="cursor-pointer hover:bg-surface-elevated border-b border-border last:border-b-0">
                  <td className="px-3 py-1.5 whitespace-nowrap">{v.city}</td>
                  <td className="px-3 py-1.5 font-mono whitespace-nowrap">{shownBarcode(v)}</td>
                  <td className="px-3 py-1.5">{v.product ?? "—"}</td>
                  <td className="px-3 py-1.5">{v.customer ?? "—"}</td>
                  <td className="px-3 py-1.5 font-mono whitespace-nowrap">{v.so_number ?? "—"}</td>
                  <td className="px-3 py-1.5 font-mono whitespace-nowrap">{v.ticket_id ?? "—"}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap tabular-nums">{String(v.business_date).slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
