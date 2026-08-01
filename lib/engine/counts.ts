// Section 9 — Count Validation Layer (aggregate totals). This is the ONLY
// place physical is used as the anchor. Computed per direction from the raw
// (post-window) rows, independently of the per-barcode variance layer.

import { normalizeStatus } from "./util";
import { parseDate } from "./dates";
import type { CountLayer, SourceRow } from "./types";

export function computeCountLayer(rows: SourceRow[], runDate?: string): CountLayer {
  const phys = rows.filter((r) => r.source === "PHYSICAL");
  const sheet = rows.filter((r) => r.source === "SHEET");
  const dt = rows.filter((r) => r.source === "DT");
  const odoo = rows.filter((r) => r.source === "ODOO");

  const primaryRows = phys.length > 0 ? phys : sheet;
  const primary_source: "PHYSICAL" | "SHEET" =
    phys.length > 0 ? "PHYSICAL" : "SHEET";

  // expected = register total minus rows marked not_done/absent.
  const notDoneInPrimary = primaryRows.filter(
    (r) => normalizeStatus(r.status) === "not_done"
  ).length;
  const expected = primaryRows.length - notDoneInPrimary;

  const dt_done = dt.filter((r) => normalizeStatus(r.status) === "done").length;
  const odoo_count = odoo.length;

  // SAME-DAY ODOO, for REPORTING only.
  //
  // odoo_count above is the reconciliation window — run-1 .. run+1 on posting
  // date (odoo-window.ts) — which exists so a next-day posting matches the
  // day's movement instead of being flagged as missing. That is right for
  // reconciliation and WRONG for a movement table: it stacks up to three days
  // of postings into one column, which is why Odoo read far larger than every
  // other book in the digest. This counts only postings dated the run date
  // itself, so the email's Odoo column measures the same 3pm-3pm window the
  // other three sources do. The ±1 window is untouched for the ladder.
  const odoo_same_day = runDate
    ? odoo.filter((r) => (parseDate(r.createdOn) ?? parseDate(r.movementDate)) === runDate).length
    : odoo_count;

  const phys_total = phys.length;
  const sheet_total = sheet.length;
  // Plain row count, unlike dt_done which is done-only. The four *_total
  // figures are what the digest's movement table compares across sources, so
  // they have to be measured the same way — mixing a done-only count with three
  // raw counts makes the columns quietly incomparable.
  const dt_total = dt.length;

  return {
    primary_source,
    expected,
    dt_done,
    dt_diff: dt_done - expected,
    odoo_count,
    odoo_same_day,
    odoo_diff: odoo_count - expected,
    phys_total,
    sheet_total,
    dt_total,
    phys_sheet_match: phys_total === sheet_total,
    phys_sheet_diff: phys_total - sheet_total,
  };
}
