// Did this truck leave with everything that was planned for it?
//
// THE ONE IDEA WORTH UNDERSTANDING. A guard never tells the app which job they
// are loading. They scan, and the jobs in play are worked out FROM the scans.
//
// That is not a convenience. The gate's whole value in the reconciliation is
// that it is the one source where a human physically saw the item — an
// independent fourth witness. The moment a guard picks "Order 3957" off a list
// and the app fills in what should be on the truck, the gate stops being a
// witness and becomes an echo of Odoo, agreeing with it by construction and
// therefore proving nothing.
//
// So: scan an item, and the picking it belongs to is now in scope. If that
// picking has nine planned lines and three were scanned, six are missing.
// A picking nobody scanned from is not this trip's business — it is on another
// truck, or later today, and warning about it would be noise.
//
// PURE. No database, no clock, no network — every rule below is a unit test,
// which matters because this is the logic that will one day stop a truck.

import { canonicalize } from "../engine/barcode";

/** A planned line, as the expected list holds it. */
export interface PlannedLine {
  barcode: string;
  barcodeCanon?: string | null;
  direction: "IN" | "OUT";
  pickingRef?: string | null;
  product?: string | null;
  soNumber?: string | null;
  customer?: string | null;
  deliveryAddress?: string | null;
}

/** What the guard actually scanned on this trip. */
export interface ScannedItem {
  barcode?: string | null;
  /** Manual entries carry a serial instead, and count just the same — the
   *  point is whether a human saw the unit, not how they recorded it. */
  serialNo?: string | null;
}

export interface MissingItem {
  barcode: string;
  product: string | null;
  soNumber: string | null;
  customer: string | null;
  deliveryAddress: string | null;
  pickingRef: string | null;
}

export interface Completeness {
  /** Planned lines across every picking this trip touched. */
  expectedTotal: number;
  /** ...of which the guard scanned this many. */
  expectedScanned: number;
  missing: MissingItem[];
  /** Scans matching no planned line. The opposite failure, and the one that
   *  decides whether this can ever be shown: an item loaded with no picking
   *  behind it would warn even against a perfect list. */
  unplannedCount: number;
  /** The jobs the scans revealed. Named so the guard is told WHICH order is
   *  short rather than handed a list of serials. */
  pickings: string[];
}

/** One key per physical label, folded, so a confusable character cannot make
 *  a scanned item look absent from a list that contains it. */
const key = (s: string | null | undefined): string | null => {
  const t = String(s ?? "").trim();
  return t ? canonicalize(t) : null;
};

/**
 * Compare what was scanned against what was planned for the jobs it touched.
 *
 * `direction` scopes the list: an outward trip is not short because inward
 * deliveries were also planned today.
 */
export function assessTrip(
  scanned: ScannedItem[],
  planned: PlannedLine[],
  direction: "IN" | "OUT"
): Completeness {
  const scannedKeys = new Set<string>();
  for (const s of scanned) {
    const k = key(s.barcode) ?? key(s.serialNo);
    if (k) scannedKeys.add(k);
  }

  const relevant = planned.filter((p) => p.direction === direction);

  // Planned lines by their folded barcode, so a scan can find its line.
  const plannedByKey = new Map<string, PlannedLine>();
  for (const p of relevant) {
    const k = key(p.barcodeCanon) ?? key(p.barcode);
    if (k && !plannedByKey.has(k)) plannedByKey.set(k, p);
  }

  // ── Which jobs did the guard touch? ───────────────────────────────────
  // A scan with no planned line reveals nothing about scope — it cannot put a
  // picking in play, because we do not know which picking it would have been.
  // It is counted as unplanned and otherwise ignored.
  const touched = new Set<string>();
  let unplannedCount = 0;
  for (const k of scannedKeys) {
    const line = plannedByKey.get(k);
    if (!line) { unplannedCount++; continue; }
    // A planned line with no picking reference cannot pull siblings in with it.
    // It still counts for itself, which the fallback below handles.
    if (line.pickingRef) touched.add(line.pickingRef);
  }

  // ── What did those jobs expect? ───────────────────────────────────────
  const inScope = relevant.filter((p) => {
    if (p.pickingRef && touched.has(p.pickingRef)) return true;
    // No picking reference: in scope only if this exact line was scanned, so a
    // reference-less line can never be reported missing on a trip that had
    // nothing to do with it.
    const k = key(p.barcodeCanon) ?? key(p.barcode);
    return !p.pickingRef && !!k && scannedKeys.has(k);
  });

  const missing: MissingItem[] = [];
  let expectedScanned = 0;
  for (const p of inScope) {
    const k = key(p.barcodeCanon) ?? key(p.barcode);
    if (k && scannedKeys.has(k)) { expectedScanned++; continue; }
    missing.push({
      barcode: p.barcode,
      product: p.product ?? null,
      soNumber: p.soNumber ?? null,
      customer: p.customer ?? null,
      deliveryAddress: p.deliveryAddress ?? null,
      pickingRef: p.pickingRef ?? null,
    });
  }

  return {
    expectedTotal: inScope.length,
    expectedScanned,
    missing,
    unplannedCount,
    pickings: [...touched].sort(),
  };
}
