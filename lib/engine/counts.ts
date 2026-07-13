// Section 9 — Count Validation Layer (aggregate totals). This is the ONLY
// place physical is used as the anchor. Computed per direction from the raw
// (post-window) rows, independently of the per-barcode variance layer.

import { normalizeStatus } from "./util";
import type { CountLayer, SourceRow } from "./types";

export function computeCountLayer(rows: SourceRow[]): CountLayer {
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

  const phys_total = phys.length;
  const sheet_total = sheet.length;

  return {
    primary_source,
    expected,
    dt_done,
    dt_diff: dt_done - expected,
    odoo_count,
    odoo_diff: odoo_count - expected,
    phys_total,
    sheet_total,
    phys_sheet_match: phys_total === sheet_total,
    phys_sheet_diff: phys_total - sheet_total,
  };
}
