"use client";

// The day, read with the GATE as the anchor.
//
// Decided 15 Sep 2026, after trying Odoo and the Delivery Tracker as the
// reference in turn and measuring what each hid. The guard is the only source
// physically present when goods cross the gate; the other three record
// consequences of that crossing, hours or a day later. So where the gate has a
// record, that record stands and the other books are checked against it.
//
// THE SHAPE, and why it is five cards and not four:
//
//   Confirmed by all three   the gate saw it and every book agrees
//   Missing from Odoo        the gate saw it; Odoo has nothing
//   Missing from Manual Sheet
//   Missing from Delivery Tracker
//   Not seen by the gate     somebody else recorded a movement the gate has not
//
// That last card is the one that keeps this honest. Delhi's gate witnessed 26%,
// 42% then 60% of each day's movements over its first three days; on 13 Sep,
// 118 movements had Odoo, the sheet and the Tracker all agreeing with nothing
// at the gate. An anchor that treated its own silence as authority would file
// those as failures of three books that were right. So the gate's PRESENCE
// wins and its ABSENCE is a question — and that card is where the question
// goes, with the coverage figure beside it so you can see the day it stops
// being one.

import { useEffect, useState } from "react";
import { Icon } from "@/components/icon";
import { Modal } from "@/components/modal";
import { ErrorState } from "@/components/error-state";
import { SOURCE_NAME } from "@/lib/ui/source-names";
import type { CityAgg } from "@/lib/hooks/use-dashboard-data";

type Bucket = "confirmedAll" | "gateNotOdoo" | "gateNotSheet" | "gateNotDt" | "notSeenByGate";

interface Row {
  /** Already the spelling a source wrote — never the canonical fold. */
  barcodeDisplay: string;
  direction: string;
  jobType: string | null;
  soNumber: string | null;
  ticketId: string | null;
  customer: string | null;
  product: string | null;
  seenBy: string;
}

const CARDS: {
  key: Bucket;
  label: string;
  hint: string;
  /** The question the list behind it answers. */
  subtitle: string;
  tone: "good" | "chase" | "coverage";
}[] = [
  {
    key: "confirmedAll",
    label: "Confirmed by all three",
    hint: `The guard saw it cross and ${SOURCE_NAME.odoo}, ${SOURCE_NAME.sheet} and ${SOURCE_NAME.dt} all have it. Nothing to do.`,
    subtitle: "The guard saw these cross and every other book agrees.",
    tone: "good",
  },
  {
    key: "gateNotOdoo",
    label: `Missing from ${SOURCE_NAME.odoo}`,
    hint: "The guard saw it cross and Odoo has no record. Outward postings run about 26 hours behind, so a fresh day will always show some of these.",
    subtitle: "The guard saw these cross; Odoo has no record of them.",
    tone: "chase",
  },
  {
    key: "gateNotSheet",
    label: `Missing from ${SOURCE_NAME.sheet}`,
    hint: "The guard saw it cross and the warehouse's own sheet does not have it.",
    subtitle: "The guard saw these cross; the warehouse sheet has no record of them.",
    tone: "chase",
  },
  {
    key: "gateNotDt",
    label: `Missing from ${SOURCE_NAME.dt}`,
    hint: "The guard saw it cross and no agent task covers it. Vendor receipts and internal transfers never enter the Tracker, so some of these are normal.",
    subtitle: "The guard saw these cross; no delivery task covers them.",
    tone: "chase",
  },
  {
    key: "notSeenByGate",
    label: "Not seen by the guard",
    hint: "Another book recorded a movement the gate has nothing for. Until the guards cover the whole day this is a question about coverage, not about stock.",
    subtitle: "Other books recorded these; the gate has no record. A coverage question, not a loss.",
    tone: "coverage",
  },
];

export default function AnchoredCards({ agg, city, loading, businessDate }: {
  agg: CityAgg | null;
  city: string;
  loading: boolean;
  businessDate?: string;
}) {
  const [open, setOpen] = useState<Bucket | null>(null);
  const a = agg?.anchored;
  const counts: Record<Bucket, number> = {
    confirmedAll: a?.confirmedAll ?? 0,
    gateNotOdoo: a?.gateNotOdoo ?? 0,
    gateNotSheet: a?.gateNotSheet ?? 0,
    gateNotDt: a?.gateNotDt ?? 0,
    notSeenByGate: a?.notSeenByGate ?? 0,
  };
  const seen = a?.gateSaw ?? 0;
  const total = seen + (a?.notSeenByGate ?? 0);
  const coverage = total > 0 ? Math.round((seen / total) * 100) : null;

  // The gate never reported: every figure here would be a zero asserting
  // something nobody checked. Say that instead of drawing five cards of noise.
  if (!loading && a && !a.gateReported) {
    return (
      <div className="card px-4 py-3 text-sm text-status-warning flex items-center gap-2">
        <Icon name="warning" size={16} />
        {SOURCE_NAME.gate} did not report for {city === "ALL" ? "any city" : city} on this day, so
        the day cannot be read against it.
      </div>
    );
  }

  return (
    <>
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <h3 className="font-headline text-lg text-text-primary">
          Checked against {SOURCE_NAME.gate}{city === "ALL" ? "" : ` · ${city}`}
        </h3>
        <p className="text-xs text-text-muted">
          {loading || coverage === null ? (
            "…"
          ) : (
            <>
              The guard witnessed <b className="text-text-secondary">{seen}</b> of{" "}
              <b className="text-text-secondary">{total}</b> movements ({coverage}%)
            </>
          )}
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 -mt-4">
        {CARDS.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setOpen(c.key)}
            disabled={!businessDate}
            title={c.hint}
            className={`card card-hover p-4 text-left flex flex-col gap-1 cursor-pointer group border-l-[3px] ${
              c.tone === "good"
                ? "border-l-success"
                : c.tone === "coverage"
                  ? "border-l-border"
                  : "border-l-danger"
            }`}
          >
            {/* Two of the five labels wrap to a second line, which pushed their
                numbers half a line below the others and made a row of cards
                read as ragged. The floor keeps every number on one baseline. */}
            <span className="text-[11px] uppercase tracking-wider text-text-muted group-hover:underline min-h-[2.4em] leading-tight">
              {c.label}
            </span>
            <span className="text-2xl font-semibold text-text-primary tabular-nums leading-tight">
              {loading ? "…" : counts[c.key]}
            </span>
          </button>
        ))}
      </div>

      {open && businessDate && (
        <AnchoredModal
          bucket={open}
          date={businessDate}
          city={city}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

function AnchoredModal({ bucket, date, city, onClose }: {
  bucket: Bucket;
  date: string;
  city: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [capped, setCapped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const card = CARDS.find((c) => c.key === bucket)!;

  useEffect(() => {
    let alive = true;
    const q = new URLSearchParams({ bucket, date });
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
  }, [bucket, date, city]);

  return (
    <Modal open onClose={onClose} size="xl" icon="fact_check"
      title={`${card.label} · ${date}`} subtitle={card.subtitle}>
      {error && <ErrorState what="these movements" detail={error} onRetry={() => location.reload()} compact />}
      {!rows && !error && <p className="text-sm text-text-muted">Loading…</p>}
      {rows && rows.length === 0 && <p className="text-sm text-text-muted">Nothing in this group for the day.</p>}
      {rows && rows.length > 0 && (
        <>
          <p className="text-sm text-text-muted mb-3">
            {rows.length} movement{rows.length === 1 ? "" : "s"}
            {capped && <span className="text-status-warning"> · showing the first 1,000 only</span>}
          </p>
          <div className="overflow-x-auto border border-border rounded-control">
            <table className="w-full text-sm border-collapse">
              <thead className="bg-surface-elevated">
                <tr>
                  {["Way", "Barcode", "Product", "Customer", "SO", "Ticket", "Job type", "Seen by"].map((h) => (
                    <th key={h} className="text-left px-3 py-2 border border-border text-xs uppercase tracking-wide text-text-muted whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.barcodeDisplay}-${r.direction}-${i}`} className="hover:bg-surface-elevated">
                    <td className="px-3 py-1.5 border border-border whitespace-nowrap">{r.direction === "IN" ? "Inward" : "Outward"}</td>
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
