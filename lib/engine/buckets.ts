// Section 10 — Bucket Layer (REAL vs INFO relabel) plus per-variance metadata
// (owner + human-readable note). The relabel is non-destructive: it only
// re-tags priority for reporting. INFO rows get priority forced to Info,
// original_priority preserved, and dampened: true.

import type { Bucket, Priority, VarianceRowOut } from "./types";

interface VarianceMeta {
  bucket: Bucket;
  responsible: string;
  note: string;
}

// REAL = chase today; INFO = data-hygiene only (Section 10).
export const VARIANCE_META: Record<string, VarianceMeta> = {
  "Fake Scan Risk": {
    bucket: "REAL",
    responsible: "delivery_team",
    note: "Agent's scan does not match the expected barcode — verify the physical unit against the SO before trusting the delivery.",
  },
  "DT-Only — Fake Scan Risk": {
    bucket: "REAL",
    responsible: "delivery_team",
    note: "Only the delivery app claims this moved — no floor record. Confirm the unit actually left the warehouse.",
  },
  "Register/DT Logged — Not in Odoo": {
    bucket: "REAL",
    responsible: "odoo_team",
    note: "Floor + DT confirm the movement but Odoo has not posted it — post the stock move today.",
  },
  "Register-Confirmed, No Odoo Record": {
    bucket: "REAL",
    responsible: "odoo_team",
    note: "Both registers agree the unit moved but nothing else corroborates — post to Odoo and confirm with DT.",
  },
  "Gate-Only Dispatch — No Ops/Odoo Trail": {
    bucket: "REAL",
    responsible: "warehouse_team",
    note: "Guard logged this at the gate but ops, DT and Odoo have no record — trace where the unit went.",
  },
  "Sheet-Only Dispatch — No Trail": {
    bucket: "REAL",
    responsible: "ops_team",
    note: "Ops sheet logged this but nothing corroborates — confirm the movement actually happened.",
  },
  "Ops-Sheet Confirmed — Gate Log Missing": {
    bucket: "REAL",
    responsible: "warehouse_team",
    note: "Ops and Odoo agree the unit moved but the gate register is the outlier — check the guard log for a missed entry.",
  },
  "Pickup Confirmed — Odoo Not Closed": {
    bucket: "REAL",
    responsible: "odoo_team",
    note: "Floor and DT agree the pickup happened but the Odoo receipt is not closed — close it today.",
  },
  "Odoo-Only Entry — No Floor Record": {
    bucket: "REAL",
    responsible: "odoo_team",
    note: "Odoo says this moved but nothing on the floor agrees — verify the posting is not a phantom entry.",
  },
  "Direction Conflict": {
    bucket: "REAL",
    responsible: "warehouse_team",
    note: "Same unit came in and went out on the same SO today — confirm it is a genuine replacement, not a double-count.",
  },
  "Replacement Missing a Leg": {
    bucket: "REAL",
    responsible: "warehouse_team",
    note: "A replacement is missing its return or dispatch leg — reconcile both legs of the swap.",
  },
  // ── INFO ──────────────────────────────────────────────────────────────
  "Odoo Update Pending — Movement Confirmed": {
    bucket: "INFO",
    responsible: "odoo_team",
    note: "Register and Odoo agree; DT just hasn't synced. No stock action needed — DT will catch up.",
  },
  "Odoo Update Pending — Cross-Check": {
    bucket: "INFO",
    responsible: "odoo_team",
    note: "Ops and DT agree the unit moved; Odoo hasn't posted yet. Expected lag, no stock action.",
  },
  "Physical + Odoo Agree — No Register/DT": {
    bucket: "INFO",
    responsible: "ops_team",
    note: "Two independent sources already confirm the movement — register/DT gap is cosmetic.",
  },
  "All-Source Field Mismatch": {
    bucket: "INFO",
    responsible: "ops_team",
    note: "Everyone agrees the unit moved; only the barcode text disagrees (OCR noise). No stock gap.",
  },
  "Duplicate Scan / Multi-Source Mismatch": {
    bucket: "INFO",
    responsible: "ops_team",
    note: "Same barcode scanned twice within one source — de-duplicate the log entry.",
  },
  "Spare/Consumable Movement": {
    bucket: "INFO",
    responsible: "ops_team",
    note: "Spare/consumable item movement — recorded for completeness, not a trackable stock unit.",
  },
};

function metaFor(name: string): VarianceMeta {
  return (
    VARIANCE_META[name] ?? {
      bucket: "INFO",
      responsible: "ops_team",
      note: "Flagged for review.",
    }
  );
}

// Apply metadata + REAL/INFO relabel to a freshly-classified row.
export function applyBucket(
  row: Omit<VarianceRowOut, "bucket" | "responsible" | "note"> & {
    note?: string;
    responsible?: string;
  }
): VarianceRowOut {
  const meta = metaFor(row.variance_name);
  const naturalPriority: Priority = row.priority;

  if (meta.bucket === "INFO") {
    return {
      ...row,
      bucket: "INFO",
      priority: "Info",
      original_priority: naturalPriority,
      dampened: true,
      responsible: row.responsible ?? meta.responsible,
      note: row.note ?? meta.note,
    };
  }

  return {
    ...row,
    bucket: "REAL",
    priority: naturalPriority,
    responsible: row.responsible ?? meta.responsible,
    note: row.note ?? meta.note,
  };
}
