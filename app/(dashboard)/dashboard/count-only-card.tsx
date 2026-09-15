"use client";

// Movements counted by quantity rather than tracked by barcode.
//
// PP boxes, spare parts, consumables and samples have no serial and never will,
// so they cannot enter the per-barcode ladder and are not variances. They were
// already summarised here from the ops sheet, DT and Odoo.
//
// WHAT CHANGED (15 Sep 2026). The GATE's own counted items were missing —
// entirely, not merely unsummarised. lib/connectors/guard.ts drops every
// barcode-less row before the engine sees it, which is correct for a
// per-barcode engine and meant a guard could photograph four PP boxes leaving
// the yard and the record reached no screen in this tool. They now have a row
// of their own, read live from gate_scans, and the row opens the actual items.
//
// Kept as their own line rather than folded into the totals above: the point of
// having the gate count them is to be able to see whether the gate and the
// paperwork agree, which a single merged number destroys.

import { useEffect, useState } from "react";
import { Icon } from "@/components/icon";
import { Modal } from "@/components/modal";
import { ErrorState } from "@/components/error-state";
import type { CityAgg } from "@/lib/hooks/use-dashboard-data";

interface CountedItem {
  id: string;
  city: string;
  direction: string;
  scannedAt: string;
  itemKind: string;
  quantity: number;
  notes: string | null;
  hasPhoto: boolean;
  vehicleNo: string | null;
  agent: string | null;
  guard: string | null;
  recordedLate: boolean;
}

const KIND_LABEL: Record<string, string> = {
  spare_part: "Spare part",
  consumable: "Consumable",
  pp_box: "PP box",
  sample: "Sample",
};

const istTime = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

export default function CountOnlyCard({ agg, city, loading, businessDate }: {
  agg: CityAgg | null;
  /** City name, or "ALL". */
  city: string;
  loading: boolean;
  /** The business date the figures describe. Without one the list cannot open. */
  businessDate?: string;
}) {
  const [open, setOpen] = useState(false);
  const gate = agg?.gateCount;
  const hasGate = !!gate && gate.items > 0;

  return (
    <>
      <div className="card px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
          Count-only movements{city === "ALL" ? "" : ` · ${city}`}
        </span>
        <span className="text-sm text-text-muted flex items-center gap-1.5">
          <Icon name="inventory_2" size={16} className="text-accent" /> PP-Box{" "}
          <b className="text-text-primary">{loading ? "…" : agg?.ppBox ?? 0}</b>
        </span>
        <span className="text-sm text-text-muted flex items-center gap-1.5">
          <Icon name="category" size={16} className="text-accent" /> Consumables{" "}
          <b className="text-text-primary">{loading ? "…" : agg?.consumable ?? 0}</b>
        </span>

        {/* The gate's own counted items. Only shown when there are some: on a
            city not yet on the app this line would otherwise read as a zero the
            gate had asserted, which it never did. */}
        {hasGate && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            disabled={!businessDate}
            className="text-sm flex items-center gap-1.5 text-text-muted hover:text-accent cursor-pointer group disabled:cursor-default"
            title={
              businessDate
                ? "Open the items the guards counted by hand"
                : "No reconciliation date in view"
            }
          >
            <Icon name="fact_check" size={16} className="text-accent" />
            <span className="group-hover:underline">Gate register</span>{" "}
            <b className="text-text-primary">{gate.in} in</b>
            <span className="text-text-disabled">/</span>
            <b className="text-text-primary">{gate.out} out</b>
            <span className="text-xs text-text-disabled">({gate.items} entries)</span>
            <Icon name="chevron_right" size={16} />
          </button>
        )}

        <span className="text-xs text-text-disabled">
          Counted by quantity, not by barcode — they never appear in the list below.
        </span>
      </div>

      {open && businessDate && (
        <CountedItemsModal
          date={businessDate}
          city={city}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** The items themselves — what a manager opens the card to check. */
function CountedItemsModal({ date, city, onClose }: {
  date: string;
  city: string;
  onClose: () => void;
}) {
  const [items, setItems] = useState<CountedItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [photo, setPhoto] = useState<{ id: string; label: string } | null>(null);

  useEffect(() => {
    let alive = true;
    const q = new URLSearchParams({ date });
    if (city !== "ALL") q.set("city", city);
    fetch(`/api/gate/counted?${q}`, { credentials: "same-origin" })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (j.error) setError(String(j.error));
        else setItems(j.items ?? []);
      })
      .catch(() => { if (alive) setError("Could not reach the server."); });
    return () => { alive = false; };
  }, [date, city]);

  const total = items?.reduce((n, i) => n + i.quantity, 0) ?? 0;

  return (
    <>
      <Modal
        open
        onClose={onClose}
        size="xl"
        icon="fact_check"
        title={`Counted by the gate · ${date}`}
        subtitle="Items the guards added by hand because there is nothing to scan. The photograph is the whole of the evidence for these, so it is one click away."
      >
        {error && <ErrorState what="the counted items" detail={error} onRetry={() => location.reload()} compact />}
        {!items && !error && <p className="text-sm text-text-muted">Loading…</p>}
        {items && items.length === 0 && (
          <p className="text-sm text-text-muted">Nothing counted by hand on this day.</p>
        )}
        {items && items.length > 0 && (
          <>
            <p className="text-sm text-text-muted mb-3">
              {items.length} entr{items.length === 1 ? "y" : "ies"} ·{" "}
              <b className="text-text-primary">{total}</b> item{total === 1 ? "" : "s"} in total
            </p>
            <div className="overflow-x-auto border border-border rounded-control">
              <table className="w-full text-sm border-collapse">
                <thead className="bg-surface-elevated">
                  <tr>
                    {["Time", "City", "Way", "Item", "Qty", "Vehicle", "Agent", "Guard", "Note", "Photo"].map((h) => (
                      <th key={h} className="text-left px-3 py-2 border border-border text-xs uppercase tracking-wide text-text-muted whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id} className="hover:bg-surface-elevated">
                      <td className="px-3 py-1.5 border border-border whitespace-nowrap tabular-nums">
                        {istTime(i.scannedAt)}
                        {i.recordedLate && (
                          <span className="badge badge-suppressed uppercase ml-1.5" title="The guard recorded this for the previous day">
                            Late
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 border border-border whitespace-nowrap">{i.city}</td>
                      <td className="px-3 py-1.5 border border-border whitespace-nowrap">
                        {i.direction === "IN" ? "Inward" : "Outward"}
                      </td>
                      <td className="px-3 py-1.5 border border-border whitespace-nowrap">
                        {KIND_LABEL[i.itemKind] ?? i.itemKind}
                      </td>
                      <td className="px-3 py-1.5 border border-border text-right tabular-nums font-semibold">
                        {i.quantity}
                      </td>
                      <td className="px-3 py-1.5 border border-border whitespace-nowrap font-mono text-xs">
                        {i.vehicleNo ?? "—"}
                      </td>
                      <td className="px-3 py-1.5 border border-border whitespace-nowrap">{i.agent ?? "—"}</td>
                      <td className="px-3 py-1.5 border border-border whitespace-nowrap">{i.guard ?? "—"}</td>
                      <td className="px-3 py-1.5 border border-border">{i.notes || "—"}</td>
                      <td className="px-3 py-1.5 border border-border text-center">
                        {i.hasPhoto ? (
                          <button
                            onClick={() => setPhoto({ id: i.id, label: `${KIND_LABEL[i.itemKind] ?? i.itemKind} × ${i.quantity} · ${istTime(i.scannedAt)}` })}
                            className="btn-icon hover:text-accent"
                            title="View the photograph"
                          >
                            <Icon name="camera" size={18} />
                          </button>
                        ) : (
                          // Never a blank cell: an entry with no photograph is
                          // the one an auditor would want to know about.
                          <span className="text-xs text-status-warning" title="No photograph was stored with this entry">
                            none
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Modal>
      {photo && <CountedPhoto scanId={photo.id} label={photo.label} onClose={() => setPhoto(null)} />}
    </>
  );
}

/**
 * One photograph, signed only when somebody asks for it.
 *
 * A day can carry hundreds of rows and a manager opens two; signing every photo
 * with the list would be hundreds of storage round trips to render a table.
 */
function CountedPhoto({ scanId, label, onClose }: { scanId: string; label: string; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/gate/photo?scanId=${encodeURIComponent(scanId)}`, { credentials: "same-origin" })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (j.url) setUrl(j.url);
        else setProblem(j.reason ?? j.error ?? "The photo could not be loaded.");
      })
      .catch(() => { if (alive) setProblem("Could not reach the server."); });
    return () => { alive = false; };
  }, [scanId]);

  return (
    <Modal open onClose={onClose} title="Photo" subtitle={label} size="md" level="stacked">
      {problem ? (
        <p className="text-sm text-text-muted">{problem}</p>
      ) : url ? (
        /* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed storage URL; next/image cannot optimise what it cannot refetch */
        <img src={url} alt={label} className="w-full rounded-control border border-border" />
      ) : (
        <p className="text-sm text-text-muted">Loading…</p>
      )}
    </Modal>
  );
}
