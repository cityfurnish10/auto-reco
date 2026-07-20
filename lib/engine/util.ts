// Shared normalizers for statuses, job types, and SO numbers.

import type { NormStatus } from "./types";

export function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Fold each platform's status vocabulary into one of five buckets. Spaces and
// hyphens collapse to "_" first, so "Out for Delivery" → "out_for_delivery",
// "Re-attempt" → "re_attempt". Odoo/DT/Guard hard-set "done"; the ops sheet's
// free-text "Physical Status" is the one that carries real delivery outcomes,
// so the not_done/pending vocabularies are deliberately broad — a term that
// falls through to "unknown" is silently ignored by the failed-delivery rule
// (which keys on "not_done") and the pending/DT-sync suppressions.
export function normalizeStatus(raw: string | undefined | null): NormStatus {
  if (!raw) return "unknown";
  const s = raw.toString().trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (
    [
      // the movement physically completed
      "done", "complete", "completed", "closed",
      "delivered", "received", "picked", "pickup", "picked_up", "pick_up",
      "collected", "handover", "handed_over", "dispatched",
    ].includes(s)
  )
    return "done";
  if (
    [
      // in progress — not yet resolved either way
      "pending", "in_transit", "transit", "in_progress", "ongoing", "processing",
      "scheduled", "rescheduled", "reattempt", "re_attempt", "reattempted",
      "assigned", "out_for_delivery", "ofd", "on_the_way", "on_hold", "hold",
      "delivery_pending", "not_attempted",
    ].includes(s)
  )
    return "pending";
  if (
    [
      "not_done", "notdone", "failed", "absent", "missing", "cancelled", "canceled",
      // Ops-sheet "Physical Status" for a failed delivery/pickup — for an
      // outbound leg these mean the unit is coming back and its return must be
      // logged inward (drives the Failed-Delivery rule).
      "not_delivered", "undelivered", "not_received", "not_picked",
      "rto", "return_to_origin", "returned", "return", "rejected", "refused",
      "denied", "declined", "not_reachable", "cnr", "customer_not_available",
      "customer_not_responding", "lost",
    ].includes(s)
  )
    return "not_done";
  if (["non_match", "nonmatch", "mismatch", "wrong", "wrong_scan"].includes(s))
    return "non_match";
  return "unknown";
}

// Uppercased job type; blank → null.
export function normalizeJobType(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = raw.toString().trim().toUpperCase().replace(/[\s-]+/g, "_");
  return s || null;
}

export function isRepair(jobType: string | null): boolean {
  return jobType === "REPAIR";
}

export function isReplace(jobType: string | null): boolean {
  return jobType === "REPLACE";
}

export function isNewRental(jobType: string | null): boolean {
  return jobType === "NEW_RENTAL" || jobType === "NEWRENTAL";
}

// Replace-as-Repair equivalence (Section 7): REPAIR or REPLACE.
export function isRepairEquivalent(jobType: string | null): boolean {
  return isRepair(jobType) || isReplace(jobType);
}

export function normalizeSO(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = raw.toString().trim().toUpperCase().replace(/\s+/g, "");
  return s || null;
}

export function blank(v: string | undefined | null): boolean {
  return !v || v.toString().trim() === "";
}

// A row whose Ops Type / job type marks it a non-rental consumable/material,
// not barcode-tracked stock — the ops sheet logs these as line items with an
// SO of "NA". Observed families on the real sheets: "Spare Parts" (toilet
// cleaner, copper pipe, cable wire), "Consumbles"/"Consumables" (barcode roll,
// carbon roll), "Refurb Material" (cooling coil). They must surface as a
// Spare/Consumable INFO row, not a REAL "no trail" variance, even when the
// barcode text itself doesn't say "spare". CONSUM matches the common
// misspelling; REFURB+MAT avoids catching a refurbished rental *unit*.
export function isSpareJobType(jobType: string | undefined | null): boolean {
  if (!jobType) return false;
  const s = jobType.toString().toUpperCase();
  return s.includes("SPARE") || s.includes("CONSUM") || (s.includes("REFURB") && s.includes("MAT"));
}
