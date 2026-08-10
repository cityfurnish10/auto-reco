// Single source of truth for variance names. Every place that emits, classifies,
// buckets, attributes a source to, or short-labels a variance references these
// constants, so the exact string can never drift across files — the DB stores it
// verbatim, and the email "Top Gap" labels + source-attribution map key off it.
//
// Names are warehouse-plain: which sources CONFIRM, which is MISSING, and the
// implied action. Source terms are standardized:
//   Gate Register = guard log · Ops Sheet = ops Google sheet · DT = Delivery
//   Tracker app · Odoo = Odoo.

export const VARIANCE = {
  // ── REAL — chase list ──────────────────────────────────────────────────
  WRONG_SCAN: "Wrong Barcode Scanned in DT",
  FLOOR_DT_NOT_ODOO: "Moved on Floor + DT — Not Posted in Odoo",
  GATE_OPS_NO_DT_ODOO: "Gate + Ops Confirm — No DT Scan or Odoo Post",
  GATE_ONLY: "Gate Register Only — No Ops / DT / Odoo Record",
  SHEET_ONLY: "Ops Sheet Only — No Gate / DT / Odoo Record",
  PICKUP_ODOO_OPEN: "Pickup Logged (Gate + DT) — Odoo Receipt Open",
  DT_ONLY: "DT Only — No Floor or Odoo Record",
  REPLACEMENT_CONFIRM: "Same Unit In + Out Today — Confirm Replacement",
  FAILED_DELIVERY: "Failed Delivery — Return Not Logged Inward",
  SHEET_NOT_DONE_BUT_POSTED: "Ops Sheet Says Not Delivered — Posted Done in DT/Odoo",
  ODOO_ONLY_TODAY: "Odoo Entry Created Today — No Gate / Ops / DT Record",

  // ── INFO — audit / posting-lag, no chase ───────────────────────────────
  // Measured 2026-07-20: 220/230 of these ALSO had a DT scan — Sheet+DT+Odoo,
  // three independent systems, all confirming; only the handwritten register
  // (via OCR) missed it. A gate-log hygiene gap, never a stock loss.
  OPS_ODOO_NO_GATE: "Ops + Odoo Confirm — Missing from Gate Register",
  ADJACENT_DAY: "Entry Dated Wrong Day — Unit Logged on Adjacent Day",
  ODOO_ONLY: "Odoo Posting Only — No Gate / Ops / DT Record",
  ODOO_POSTED_NEXT_DAY: "Odoo Entry Made Late — Posted Next Day",
  // The same fact as ODOO_POSTED_NEXT_DAY, for a posting too far out to be in
  // the ±1 pull window. Vendor PO receipts are the whole reason it exists:
  // measured 2026-08-10, EVERY ONE of 162 "PO Inward" sheet rows had its Odoo
  // receipt posted +2 or +3 days later, so the ±1 window could never match one.
  ODOO_POSTED_LATE: "Odoo Entry Made Late — Posted a Few Days On",
  OPS_ODOO_NO_DT: "Ops + Odoo Confirm — No DT Scan",
  DT_ODOO_NO_SHEET: "DT + Odoo Confirm — Missing from Ops Sheet",
  GATE_OPS_ODOO_NO_DT: "Gate + Ops + Odoo Confirm — DT Scan Pending",
  GATE_ODOO_NO_OPS_DT: "Gate + Odoo Confirm — No Ops Sheet or DT Scan",
  OPS_DT_ODOO_PENDING: "Ops + DT Confirm — Odoo Posting Pending",
  FIELD_MISMATCH: "All Sources Agree — Barcode Text Differs (OCR/Typo)",
  DUPLICATE: "Duplicate Scan — Same Barcode Logged Twice",
} as const;

export type VarianceName = (typeof VARIANCE)[keyof typeof VARIANCE];
