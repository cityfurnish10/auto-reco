// Which source a variance primarily implicates — the "Source" column on the
// dashboard and the reliability tally in analytics. Centralized here so the
// persistence layer (writing the `source` column) and the analytics page share
// one mapping. Covers every variance_name emitted by the ladder + buckets +
// direction-conflict layers (see lib/engine/buckets.ts VARIANCE_META).

import { VARIANCE } from "./variance-names";
import type { OutputDirection } from "./types";

export type SourceLabel = "Odoo" | "DT" | "Sheet" | "Physical" | "Cross";

const SOURCE_OF: Record<string, SourceLabel> = {
  // Odoo is the outlier / missing posting
  [VARIANCE.ODOO_ONLY]: "Odoo",
  [VARIANCE.ODOO_ONLY_TODAY]: "Odoo",
  [VARIANCE.ODOO_POSTED_NEXT_DAY]: "Odoo",
  [VARIANCE.FLOOR_DT_NOT_ODOO]: "Odoo",
  [VARIANCE.GATE_OPS_NO_DT_ODOO]: "Odoo",
  [VARIANCE.PICKUP_ODOO_OPEN]: "Odoo",
  [VARIANCE.GATE_OPS_ODOO_NO_DT]: "Odoo",
  [VARIANCE.OPS_DT_ODOO_PENDING]: "Odoo",
  // Delivery Tracker scan issue
  [VARIANCE.WRONG_SCAN]: "DT",
  [VARIANCE.DT_ONLY]: "DT",
  [VARIANCE.OPS_ODOO_NO_DT]: "DT",
  // Ops sheet is the source
  [VARIANCE.SHEET_ONLY]: "Sheet",
  [VARIANCE.DT_ODOO_NO_SHEET]: "Sheet",
  [VARIANCE.FAILED_DELIVERY]: "Sheet",
  // Physical / gate register
  [VARIANCE.GATE_ONLY]: "Physical",
  [VARIANCE.OPS_ODOO_NO_GATE]: "Physical",
  [VARIANCE.GATE_ODOO_NO_OPS_DT]: "Physical",
  [VARIANCE.FIELD_MISMATCH]: "Physical", // OCR noise — guard scan the usual culprit
  [VARIANCE.DUPLICATE]: "Physical",
  [VARIANCE.ADJACENT_DAY]: "Physical", // date-misaligned register page / late write-up
  // Cross-direction (both legs)
  [VARIANCE.REPLACEMENT_CONFIRM]: "Cross",
};

// The 4 real data sources (excludes the derived "Cross") — for reliability tallies.
export const DATA_SOURCES: readonly SourceLabel[] = ["Odoo", "DT", "Sheet", "Physical"];

export function varianceSource(
  varianceName: string,
  direction?: OutputDirection
): SourceLabel {
  if (direction === "CROSS") return "Cross";
  return SOURCE_OF[varianceName] ?? "Physical";
}
