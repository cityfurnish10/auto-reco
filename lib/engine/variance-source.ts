// Which source a variance primarily implicates — the "Source" column on the
// dashboard and the reliability tally in analytics. Centralized here so the
// persistence layer (writing the `source` column) and the analytics page share
// one mapping. Covers every variance_name emitted by the ladder + buckets +
// direction-conflict layers (see lib/engine/buckets.ts VARIANCE_META).

import type { OutputDirection } from "./types";

export type SourceLabel = "Odoo" | "DT" | "Sheet" | "Physical" | "Cross";

const SOURCE_OF: Record<string, SourceLabel> = {
  // Odoo is the outlier / missing posting
  "Odoo-Only Entry — No Floor Record": "Odoo",
  "Register/DT Logged — Not in Odoo": "Odoo",
  "Register-Confirmed, No Odoo Record": "Odoo",
  "Pickup Confirmed — Odoo Not Closed": "Odoo",
  "Odoo Update Pending — Movement Confirmed": "Odoo",
  "Odoo Update Pending — Cross-Check": "Odoo",
  // Delivery Tracker scan issue
  "Fake Scan Risk": "DT",
  "DT-Only — Fake Scan Risk": "DT",
  "DT Missing — Ops & Odoo Agree": "DT",
  // Ops sheet is the source
  "Sheet-Only Dispatch — No Trail": "Sheet",
  "Ops Sheet Missing — DT & Odoo Agree": "Sheet",
  "Failed Delivery — Return Not Logged": "Sheet",
  "PP Box Movement (Count Only)": "Sheet",
  // Physical / gate register
  "Gate-Only Dispatch — No Ops/Odoo Trail": "Physical",
  "Ops-Sheet Confirmed — Gate Log Missing": "Physical",
  "Physical + Odoo Agree — No Register/DT": "Physical",
  "All-Source Field Mismatch": "Physical", // OCR noise — guard scan the usual culprit
  "Duplicate Scan / Multi-Source Mismatch": "Physical",
  "Spare/Consumable Movement": "Physical",
  // Cross-direction (both legs)
  "Direction Conflict": "Cross",
  "Replacement Missing a Leg": "Cross",
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
