// DT direction derivation (DB MODEL.md §14). Direction is not stored directly
// on `tasks`/`orderfromcityfurnishes` — derive it via this priority-ordered
// switch, which mirrors the existing Metabase query logic (cards 317/404).
// Returns null when the row is ambiguous (rule 6) — callers should skip it.

import type { Direction } from "../engine/types";

export interface DtDirectionInput {
  category?: string;
  jobType?: string;
  subCategory?: string;
  movement?: string; // raw tasks.movement field
  clientStatus?: string; // orderfromcityfurnishes.client_Status
  hasDeliveryId: boolean;
  hasPickupDeliveryId: boolean;
}

function normalizeMovement(raw?: string): Direction | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "out") return "OUT";
  if (s === "in") return "IN";
  return null; // "=" or anything else is ambiguous (§14)
}

export function deriveDtDirection(input: DtDirectionInput): Direction | null {
  if (input.category === "Order") return "OUT";

  if (input.jobType === "Pickup and Refund" || input.jobType === "PO Payment") {
    return "IN";
  }

  if (input.jobType === "Refurb Transfer" || input.jobType === "Stock Transfer") {
    return normalizeMovement(input.movement);
  }

  if (input.subCategory === "Replace" || input.subCategory === "Repair") {
    if (input.clientStatus === "Delivery Pending") return "OUT";
    if (input.clientStatus === "Replacement In") return "IN";
    return null;
  }

  if (input.subCategory === "Upgrade") {
    if (input.hasDeliveryId) return "OUT";
    if (input.hasPickupDeliveryId) return "IN";
    return null;
  }

  return null; // default: ambiguous, skip
}

// Job types excluded entirely from reconciliation (DB MODEL.md §13/§23b).
export const DT_EXCLUDED_JOB_TYPES = ["New - Buy", "B2B", "Order Transfer"];
