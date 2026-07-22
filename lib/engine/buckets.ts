// Section 10 — Bucket Layer (REAL vs INFO relabel) plus per-variance metadata
// (owner + human-readable note). The relabel is non-destructive: it only
// re-tags priority for reporting. INFO rows get priority forced to Info,
// original_priority preserved, and dampened: true.

import { VARIANCE } from "./variance-names";
import type { Bucket, Priority, VarianceRowOut } from "./types";

interface VarianceMeta {
  bucket: Bucket;
  responsible: string;
  note: string;
}

// REAL = chase today; INFO = data-hygiene only (Section 10). Keyed by the
// canonical variance names (lib/engine/variance-names.ts).
export const VARIANCE_META: Record<string, VarianceMeta> = {
  // ── REAL — chase list ──────────────────────────────────────────────────
  [VARIANCE.WRONG_SCAN]: {
    bucket: "REAL",
    responsible: "delivery_team",
    note: "The DT scan does not match the expected barcode — verify the physical unit against the SO before trusting the delivery.",
  },
  [VARIANCE.DT_ONLY]: {
    bucket: "REAL",
    responsible: "delivery_team",
    note: "Only DT claims this moved — no floor record. Confirm the unit actually left the warehouse.",
  },
  [VARIANCE.FLOOR_DT_NOT_ODOO]: {
    bucket: "REAL",
    responsible: "odoo_team",
    note: "Gate register + DT confirm the movement but Odoo has not posted it — post the stock move today.",
  },
  [VARIANCE.GATE_OPS_NO_DT_ODOO]: {
    bucket: "REAL",
    responsible: "odoo_team",
    note: "Gate register + ops sheet agree the unit moved, but there is no DT scan and no Odoo posting — post to Odoo and check DT.",
  },
  [VARIANCE.GATE_ONLY]: {
    bucket: "REAL",
    responsible: "warehouse_team",
    note: "Only the gate register logged this — ops sheet, DT and Odoo have no record. Trace where the unit went.",
  },
  [VARIANCE.SHEET_ONLY]: {
    bucket: "REAL",
    responsible: "ops_team",
    note: "Only the ops sheet logged this — nothing else corroborates. Confirm the movement actually happened.",
  },
  [VARIANCE.OPS_ODOO_NO_GATE]: {
    // INFO, not REAL (measured 2026-07-20: 220 of 230 such rows ALSO carried a
    // DT scan — Sheet+DT+Odoo all confirmed; only the handwritten register /
    // its OCR missed the line). The movement is fully documented in the typed
    // systems; a gate-log gap is hygiene, the same family as the other
    // one-source-missing INFO rows below. Never a stock loss.
    bucket: "INFO",
    responsible: "warehouse_team",
    note: "Ops sheet + Odoo (and usually DT) confirm the movement; only the gate register is missing the entry. Gate-log hygiene — remind the guard post, no stock action.",
  },
  [VARIANCE.PICKUP_ODOO_OPEN]: {
    bucket: "REAL",
    responsible: "odoo_team",
    note: "Gate register + DT confirm the pickup, but the Odoo receipt is not closed — close it today.",
  },
  [VARIANCE.REPLACEMENT_CONFIRM]: {
    bucket: "REAL",
    responsible: "warehouse_team",
    note: "The same unit came in and went out on the same SO today — confirm it is a genuine replacement, not a double-count.",
  },
  [VARIANCE.FAILED_DELIVERY]: {
    bucket: "REAL",
    responsible: "ops_team",
    note: "Marked Not Delivered on the way out but the return was never logged inward — confirm the unit is back and write it into the inward register.",
  },
  [VARIANCE.ODOO_ONLY_TODAY]: {
    // Fires ONLY for customer flows (SO present, not an /INT/ internal
    // transfer) with no floor trace on this or nearby days — vendor PO receipts
    // (serialized at receipt, floor logs the truck not each serial), internal
    // transfers, and Odoo backlog entries all stay INFO (see ladder rung 9 and
    // the recent-floor gate in run.ts).
    bucket: "REAL",
    responsible: "warehouse_team",
    note: "Odoo booked this customer movement today (record created today) and no gate / ops / DT / sheet source logged it — a same-day movement the floor missed, or a phantom posting. Chase: confirm the unit physically moved and log it, or void the Odoo entry.",
  },
  // ── INFO — audit / posting-lag ─────────────────────────────────────────
  // INFO, not REAL (measured on live data): the great majority of Odoo-only
  // rows are Odoo batch-posting EARLIER days' movements (sml.date is the posting
  // timestamp, but the record's create_date predates the run day), whose floor
  // records live on the movement's own day — ops never chase these. The subset
  // whose record was CREATED today with no floor record is split off to the REAL
  // ODOO_ONLY_TODAY chase item above (see ladder rung 9). original_priority High.
  [VARIANCE.ODOO_ONLY]: {
    bucket: "INFO",
    responsible: "odoo_team",
    note: "Odoo posting today of a record created on an earlier day — a late posting of an earlier movement whose floor record lives on its own day. Audit tally, not a stock action.",
  },
  [VARIANCE.ODOO_POSTED_NEXT_DAY]: {
    bucket: "INFO",
    responsible: "odoo_team",
    note: "The floor confirmed this movement for the day, and the Odoo entry does exist — it was just posted a day late (the 1-day buffer picked it up). No action; the entry is made.",
  },
  [VARIANCE.GATE_OPS_ODOO_NO_DT]: {
    bucket: "INFO",
    responsible: "odoo_team",
    note: "Gate register + ops sheet + Odoo all confirm the movement; only the DT scan is pending. No stock action — DT will catch up.",
  },
  [VARIANCE.OPS_DT_ODOO_PENDING]: {
    bucket: "INFO",
    responsible: "odoo_team",
    note: "Ops sheet + DT confirm the unit moved; Odoo hasn't posted yet. Expected lag, no stock action.",
  },
  [VARIANCE.GATE_ODOO_NO_OPS_DT]: {
    bucket: "INFO",
    responsible: "ops_team",
    note: "Gate register + Odoo already confirm the movement — the ops-sheet / DT gap is cosmetic.",
  },
  [VARIANCE.FIELD_MISMATCH]: {
    bucket: "INFO",
    responsible: "ops_team",
    note: "Every source agrees the unit moved; only the barcode text differs (OCR/typo). No stock gap.",
  },
  [VARIANCE.DUPLICATE]: {
    bucket: "INFO",
    responsible: "ops_team",
    note: "Same barcode logged twice within one source — de-duplicate the entry.",
  },
  [VARIANCE.OPS_ODOO_NO_DT]: {
    bucket: "INFO",
    responsible: "delivery_team",
    note: "Ops sheet + Odoo both confirm the movement; only DT has no scan. DT hygiene, no stock gap.",
  },
  [VARIANCE.ADJACENT_DAY]: {
    bucket: "INFO",
    responsible: "ops_team",
    note: "This unit's movement is recorded across the floor systems on a NEARBY day — this row is a date misalignment (register page spanning days, or a late write-up), not a missing entry. No action.",
  },
  [VARIANCE.DT_ODOO_NO_SHEET]: {
    bucket: "INFO",
    responsible: "ops_team",
    note: "DT + Odoo both confirm the movement; the ops sheet entry is missing. Update the sheet, no stock gap.",
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
