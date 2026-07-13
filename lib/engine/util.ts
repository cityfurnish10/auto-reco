// Shared normalizers for statuses, job types, and SO numbers.

import type { NormStatus } from "./types";

export function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function normalizeStatus(raw: string | undefined | null): NormStatus {
  if (!raw) return "unknown";
  const s = raw.toString().trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["done", "complete", "completed", "delivered", "received", "closed"].includes(s))
    return "done";
  if (["pending", "in_transit", "transit", "ongoing"].includes(s))
    return "pending";
  if (["not_done", "notdone", "failed", "absent", "missing", "cancelled", "canceled"].includes(s))
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
