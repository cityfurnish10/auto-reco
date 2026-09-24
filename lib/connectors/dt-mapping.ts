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
    // Any other client status falls through to the links below rather than
    // being dropped — see the note at the end.
  }

  if (input.subCategory === "Upgrade") {
    if (input.hasDeliveryId) return "OUT";
    if (input.hasPickupDeliveryId) return "IN";
  }

  // LAST RESORT, NOT A SKIP. The switch above reads the job's own words; when
  // none of them fits, the link the item hangs off still says which way it
  // went — an item on a delivery is going out, one on a pickup is coming in.
  // Two rows a day fell through here and were dropped silently, which is the
  // same private filtering the exclusions above were removed for.
  if (input.hasPickupDeliveryId && !input.hasDeliveryId) return "IN";
  if (input.hasDeliveryId && !input.hasPickupDeliveryId) return "OUT";
  return null; // genuinely undecidable: both links, or neither
}

/**
 * NOTHING IS EXCLUDED AT THE SOURCE ANY MORE (owner, 24 Sep 2026).
 *
 * This used to hold ["New - Buy", "B2B", "Order Transfer"], dropped before the
 * Tracker's rows ever reached the engine. It hid 38 outward units on Delhi's
 * 22 Sep alone — the Tracker's own screen said 87 outward done, the tool said
 * 49 — and the gap could not be explained from anything the tool showed.
 *
 * The owner's rule: "take all the data that is asked of you, do not filter on
 * your conditions. If it's a movement or not, we will decide." A source read
 * through a private filter is no longer an independent witness, which is the
 * whole point of having four of them. Anything that should not count is now
 * decided in the open — by the engine, with a name, where a human can see it.
 *
 * Kept as an (empty) export so the two call sites still say out loud that they
 * exclude nothing, and so re-introducing a filter is a visible change.
 */
export const DT_EXCLUDED_JOB_TYPES: string[] = [];
