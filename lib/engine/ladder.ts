// Section 6 — The Variance Ladder. Given a BarcodeView (already past
// suppression), classify by presence pattern in priority order. Returns the
// natural variance name + priority, or null when fully reconciled.
//
// Reported-awareness (added after auditing real 2026-07-12 data): every rung
// that blames a source for an ABSENCE only fires when that source actually
// REPORTED for this city+run (connector OK, ≥1 row). An unreported source's
// absence is uninformative — a Metabase outage or an ops sheet not yet filled
// in must read as "source down", not as hundreds of false HIGH variances.
// With all sources reported (the default), behavior is identical to the
// original 4-source ladder. With the guard register unreported (the common
// nightly case — OCR uploads are optional/asynchronous), the ladder runs in a
// "3 typed sources" mode: Sheet+DT+Odoo carry the reconciliation, guard-blaming
// rungs are skipped, and Sheet+DT-agree-Odoo-missing escalates from INFO to
// the REAL "Not in Odoo" chase item (which is exactly what ops hunt manually
// on WhatsApp every morning).

import { hasDone, rawBarcodesDiffer } from "./views";
import { ALL_REPORTED } from "./types";
import type { BarcodeView, Priority, ReportedSources } from "./types";

export interface LadderHit {
  variance_name: string;
  priority: Priority;
}

export function classify(
  v: BarcodeView,
  rep: ReportedSources = ALL_REPORTED
): LadderHit | null {
  const P = v.P.present;
  const S = v.S.present;
  const D = v.D.present;
  const O = v.O.present;

  // 1. DT status = non-match (agent scanned wrong barcode). Presence-based.
  if (v.dtNonMatch) return { variance_name: "Fake Scan Risk", priority: "High" };

  // 2. DT + every reported floor source agree; Odoo reported but missing.
  //    (4-source: P+S+D no O — unchanged. No-guard: S+D no O, escalated from
  //    the old INFO rung 12 — matches real ops practice: "Odoo out missing"
  //    is the morning chase list.) Floor corroboration = each of P/S that
  //    reported also has the barcode.
  const floorCorroborates = (!rep.P || P) && (!rep.S || S);
  if (D && !O && rep.O && floorCorroborates)
    return { variance_name: "Register/DT Logged — Not in Odoo", priority: "High" };

  // 3. P + S only (guard + sheet agree; DT and Odoo reported but silent).
  if (P && S && !D && !O && rep.D && rep.O)
    return { variance_name: "Register-Confirmed, No Odoo Record", priority: "High" };

  // 4. P only.
  if (P && !S && !D && !O && rep.S && rep.D && rep.O)
    return { variance_name: "Gate-Only Dispatch — No Ops/Odoo Trail", priority: "High" };

  // 5. S only.
  if (S && !P && !D && !O && rep.D && rep.O)
    return { variance_name: "Sheet-Only Dispatch — No Trail", priority: "High" };

  // 6. S + O, no P — only meaningful when the guard register reported.
  if (S && O && !P && rep.P)
    return { variance_name: "Ops-Sheet Confirmed — Gate Log Missing", priority: "High" };

  // 6b. (no-guard mode) S + O agree, DT reported but missing → app hygiene.
  if (S && O && !D && !rep.P && rep.D)
    return { variance_name: "DT Missing — Ops & Odoo Agree", priority: "Info" };

  // 7. P + D, no S/O (rung 2 already handled the S-unreported case).
  if (P && D && !S && !O && rep.O)
    return { variance_name: "Pickup Confirmed — Odoo Not Closed", priority: "High" };

  // 8. D only, with at least one reported floor source contradicting it.
  if (D && !P && !S && !O && rep.O && (rep.S || rep.P))
    return { variance_name: "DT-Only — Fake Scan Risk", priority: "High" };

  // 9. O only — and the posting is dated the run day itself. Postings pulled
  //    from adjacent days (posting-lag match-targets) are judged in their own
  //    day's run, never here.
  if (O && !P && !S && !D && rep.S && rep.D && v.odooSameDay)
    return { variance_name: "Odoo-Only Entry — No Floor Record", priority: "High" };

  // 9b. D + O agree, sheet reported but missing → ops-sheet hygiene.
  if (D && O && !S && !P && rep.S)
    return { variance_name: "Ops Sheet Missing — DT & Odoo Agree", priority: "Info" };

  // 10. P + S + O, no D.
  if (P && S && O && !D && rep.D)
    return { variance_name: "Odoo Update Pending — Movement Confirmed", priority: "Info" };

  // 11. P + O only.
  if (P && O && !S && !D)
    return { variance_name: "Physical + Odoo Agree — No Register/DT", priority: "Info" };

  // 12. S + D, no P/O — guard reported but gate entry missing AND Odoo
  //     missing (4-source only; the no-guard case escalated at rung 2).
  if (S && D && !P && !O && rep.P && rep.O)
    return { variance_name: "Odoo Update Pending — Cross-Check", priority: "Info" };

  // 13. Every reported source present but barcodes differ → OCR noise.
  const allReportedPresent =
    (!rep.P || P) && (!rep.S || S) && (!rep.D || D) && (!rep.O || O) && (P || S || D || O);
  if (allReportedPresent && rawBarcodesDiffer(v))
    return { variance_name: "All-Source Field Mismatch", priority: "Info" };

  // 14. Reconciled, or an uncovered/uninformative pattern.
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
