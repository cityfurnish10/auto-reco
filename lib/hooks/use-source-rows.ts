"use client";

// Evidence behind a variance: what each of the four systems actually recorded
// for this barcode in this run.
//
// The important subtlety is that a missing row is ambiguous — it can mean
// "this source was working and simply had no record of this unit" (real
// evidence) or "this source never ingested that night at all" (no evidence
// either way, e.g. the guard register wasn't uploaded). Presenting the second
// as the first would be actively misleading, so alongside the item's rows we
// probe each source's ROW COUNT for the whole run: total 0 ⇒ that source never
// reported, and the UI must say so rather than accusing it.
//
// Uses the existing /api/sources route — no server change needed.

import { useEffect, useRef, useState } from "react";
import type { SourceRowDB } from "../db/schema";

export const EVIDENCE_SOURCES = ["PHYSICAL", "SHEET", "DT", "ODOO"] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export const SOURCE_LABEL: Record<EvidenceSource, string> = {
  PHYSICAL: "Gate register",
  SHEET: "Ops sheet",
  DT: "Delivery Tracker",
  ODOO: "Odoo",
};

export interface SourceEvidence {
  bySource: Record<EvidenceSource, SourceRowDB[]>;
  /** Rows that source ingested for the whole run — 0 ⇒ it never reported. */
  coverage: Record<EvidenceSource, number>;
  loading: boolean;
  error: string | null;
}

const emptyBySource = (): Record<EvidenceSource, SourceRowDB[]> => ({
  PHYSICAL: [],
  SHEET: [],
  DT: [],
  ODOO: [],
});
const zeroCoverage = (): Record<EvidenceSource, number> => ({
  PHYSICAL: 0,
  SHEET: 0,
  DT: 0,
  ODOO: 0,
});

export function useSourceRows(opts: {
  runId: string | null;
  barcode: string | null;
  city: string | null;
  enabled: boolean;
}): SourceEvidence {
  const { runId, barcode, city, enabled } = opts;
  const [bySource, setBySource] = useState(emptyBySource);
  const [coverage, setCoverage] = useState(zeroCoverage);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0); // a newer request supersedes this one

  /* eslint-disable react-hooks/set-state-in-effect -- async fetch bookkeeping */
  useEffect(() => {
    if (!enabled || !runId || !barcode || !city) {
      setBySource(emptyBySource());
      setCoverage(zeroCoverage());
      setLoading(false);
      setError(null);
      return;
    }
    const mine = ++seq.current;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);

    const base = `/api/sources?run_id=${encodeURIComponent(runId)}&city=${encodeURIComponent(city)}`;
    const opt = { credentials: "same-origin" as const, signal: ctrl.signal };

    Promise.all([
      // The item's own rows across every source…
      fetch(`${base}&barcode=${encodeURIComponent(barcode)}&pageSize=200`, opt).then((r) =>
        r.ok ? r.json() : { data: [] }
      ),
      // …and one cheap count per source to tell "no record" from "never ran".
      ...EVIDENCE_SOURCES.map((s) =>
        fetch(`${base}&source=${s}&pageSize=1`, opt).then((r) => (r.ok ? r.json() : { total: 0 }))
      ),
    ])
      .then(([rowsRes, ...counts]) => {
        if (seq.current !== mine) return;
        const grouped = emptyBySource();
        for (const row of (rowsRes.data ?? []) as SourceRowDB[]) {
          const s = row.source as EvidenceSource;
          if (grouped[s]) grouped[s].push(row);
        }
        const cov = zeroCoverage();
        EVIDENCE_SOURCES.forEach((s, i) => {
          cov[s] = (counts[i] as { total?: number })?.total ?? 0;
        });
        setBySource(grouped);
        setCoverage(cov);
      })
      .catch((e: unknown) => {
        if (seq.current !== mine) return;
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
        setBySource(emptyBySource());
        setCoverage(zeroCoverage());
      })
      .finally(() => {
        if (seq.current === mine) setLoading(false);
      });

    return () => ctrl.abort();
  }, [runId, barcode, city, enabled]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return { bySource, coverage, loading, error };
}
