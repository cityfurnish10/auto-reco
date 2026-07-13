// Build the per-direction BarcodeView universe (Section 2/6): union of every
// canonical barcode seen in any source, with presence + status per source.

import type { City } from "../sample-data";
import { canonicalize } from "./barcode";
import { normalizeJobType, normalizeStatus } from "./util";
import type {
  BarcodeView,
  Direction,
  SourceKind,
  SourcePresence,
  SourceRow,
} from "./types";

function emptyPresence(): SourcePresence {
  return { present: false, count: 0, statuses: [], rawBarcodes: [] };
}

function presenceFor(view: BarcodeView, source: SourceKind): SourcePresence {
  switch (source) {
    case "PHYSICAL":
      return view.P;
    case "SHEET":
      return view.S;
    case "DT":
      return view.D;
    case "ODOO":
      return view.O;
  }
}

// rows are already: this city, this direction, valid barcodes only.
export function buildViews(
  rows: SourceRow[],
  city: City,
  direction: Direction
): Map<string, BarcodeView> {
  const views = new Map<string, BarcodeView>();

  for (const row of rows) {
    const canonical = canonicalize(row.barcode);
    let view = views.get(canonical);
    if (!view) {
      view = {
        canonical,
        direction,
        city,
        P: emptyPresence(),
        S: emptyPresence(),
        D: emptyPresence(),
        O: emptyPresence(),
        soNumber: null,
        ticketId: null,
        customer: null,
        product: null,
        jobType: null,
        date: "",
        dtNonMatch: false,
        duplicateSources: [],
      };
      views.set(canonical, view);
    }

    const p = presenceFor(view, row.source);
    p.present = true;
    p.count += 1;
    p.statuses.push(normalizeStatus(row.status));
    const rawUpper = row.barcode.toUpperCase().replace(/\s+/g, "");
    if (!p.rawBarcodes.includes(rawUpper)) p.rawBarcodes.push(rawUpper);

    // Carry identifying fields from whichever source supplies them.
    if (!view.soNumber && row.soNumber) view.soNumber = row.soNumber;
    if (!view.ticketId && row.ticketId) view.ticketId = row.ticketId;
    if (!view.customer && row.customer) view.customer = row.customer;
    if (!view.product && row.product) view.product = row.product;
    if (row.source === "ODOO" && row.jobType) {
      view.jobType = normalizeJobType(row.jobType);
    }
    if (row.source === "DT" && normalizeStatus(row.status) === "non_match") {
      view.dtNonMatch = true;
    }
  }

  // Post-pass: duplicate sources (count > 1) and distinct-raw flag.
  for (const view of Array.from(views.values())) {
    view.duplicateSources = (["PHYSICAL", "SHEET", "DT", "ODOO"] as SourceKind[])
      .filter((s) => presenceFor(view, s).count > 1);
  }

  return views;
}

// True if the same canonical had more than one distinct raw spelling across
// all sources → OCR noise (Section 6 All-Source Field Mismatch).
export function rawBarcodesDiffer(view: BarcodeView): boolean {
  const all = new Set<string>();
  for (const s of [view.P, view.S, view.D, view.O]) {
    for (const r of s.rawBarcodes) all.add(r);
  }
  return all.size > 1;
}

export function hasDone(p: SourcePresence): boolean {
  return p.statuses.includes("done");
}

export function allPendingOrNotDone(p: SourcePresence): boolean {
  return (
    p.present &&
    p.statuses.length > 0 &&
    p.statuses.every((s) => s === "pending" || s === "not_done")
  );
}
