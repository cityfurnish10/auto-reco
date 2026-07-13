// Section 6 — The Variance Ladder. Given a BarcodeView (already past
// suppression), classify by presence pattern in priority order. Returns the
// natural variance name + priority, or null when fully reconciled.

import { hasDone, rawBarcodesDiffer } from "./views";
import type { BarcodeView, Priority } from "./types";

export interface LadderHit {
  variance_name: string;
  priority: Priority;
}

export function classify(v: BarcodeView): LadderHit | null {
  const P = v.P.present;
  const S = v.S.present;
  const D = v.D.present;
  const O = v.O.present;

  // 1. DT status = non-match (agent scanned wrong barcode).
  if (v.dtNonMatch) return { variance_name: "Fake Scan Risk", priority: "High" };

  // 2. P + S + D, no O.
  if (P && S && D && !O)
    return { variance_name: "Register/DT Logged — Not in Odoo", priority: "High" };

  // 3. P + S only.
  if (P && S && !D && !O)
    return { variance_name: "Register-Confirmed, No Odoo Record", priority: "High" };

  // 4. P only.
  if (P && !S && !D && !O)
    return { variance_name: "Gate-Only Dispatch — No Ops/Odoo Trail", priority: "High" };

  // 5. S only.
  if (S && !P && !D && !O)
    return { variance_name: "Sheet-Only Dispatch — No Trail", priority: "High" };

  // 6. S + O, no P.
  if (S && O && !P)
    return { variance_name: "Ops-Sheet Confirmed — Gate Log Missing", priority: "High" };

  // 7. P + D, no S/O.
  if (P && D && !S && !O)
    return { variance_name: "Pickup Confirmed — Odoo Not Closed", priority: "High" };

  // 8. D only.
  if (D && !P && !S && !O)
    return { variance_name: "DT-Only — Fake Scan Risk", priority: "High" };

  // 9. O only.
  if (O && !P && !S && !D)
    return { variance_name: "Odoo-Only Entry — No Floor Record", priority: "High" };

  // 10. P + S + O, no D.
  if (P && S && O && !D)
    return { variance_name: "Odoo Update Pending — Movement Confirmed", priority: "Info" };

  // 11. P + O only.
  if (P && O && !S && !D)
    return { variance_name: "Physical + Odoo Agree — No Register/DT", priority: "Info" };

  // 12. S + D, no P/O.
  if (S && D && !P && !O)
    return { variance_name: "Odoo Update Pending — Cross-Check", priority: "Info" };

  // 13. All four present but barcodes differ across sources → OCR noise.
  if (P && S && D && O && rawBarcodesDiffer(v))
    return { variance_name: "All-Source Field Mismatch", priority: "Info" };

  // 14. All four present & consistent, or an uncovered pattern → reconciled.
  return null;
}

// Section 5 — a duplicate scan (same canonical twice within one source) is its
// own variance, unless suppressed by DT All-Pending.
export function duplicateHit(v: BarcodeView): LadderHit | null {
  if (v.duplicateSources.length === 0) return null;
  return {
    variance_name: "Duplicate Scan / Multi-Source Mismatch",
    priority: "Info",
  };
}

export { hasDone };
