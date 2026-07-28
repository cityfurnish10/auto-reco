// Owner-facing vocabulary for the 22 canonical variance names.
//
// The engine's names describe WHICH SOURCES agreed ("Ops + Odoo Confirm —
// Missing from Gate Register"). That is precise and useless to the person who
// only wants to know whether stock is still accounted for. This module is the
// single translation layer between the two, shared by the digest email and the
// dashboards so a term can never mean one thing on screen and another in the
// inbox.
//
// It lives in lib/ui/ beside variance-format.ts (RESPONSIBLE_LABEL,
// DIRECTION_LABEL) because it is presentation. It must NEVER be imported by
// lib/engine/* — the engine does not branch on how a thing is displayed.
//
// THE TIER RULE, which decides every case below:
//   Tier 1  we cannot prove where the unit is.
//   Tier 2  we know where it is; a record needs fixing.
//   Tier 3  nothing to do.
//
// Tiers deliberately re-cut `bucket`. "Moved on Floor + DT — Not Posted in
// Odoo" is REAL but Tier 2: the unit is on the floor and confirmed by two
// sources, only Odoo is behind. So the email's headline count is smaller than
// the dashboard's open count, and the digest says so in a reconciling line
// rather than leaving the reader to spot the discrepancy.

import { VARIANCE, type VarianceName } from "../engine/variance-names";
import { VARIANCE_META } from "../engine/buckets";
import { isNewRental, isRepairEquivalent } from "../engine/util";
import { RESPONSIBLE_LABEL } from "./variance-format";

export type Tier = 1 | 2 | 3;

export interface TierMeta {
  /** Owner-facing heading. Never a colour word — colour is not information. */
  heading: string;
  /** Inline hex for the email; mail clients have no access to CSS tokens. */
  hex: string;
  /** LITERAL class string. Tailwind scans lib/**, so it must never be computed. */
  badge: string;
}

export const TIER: Record<Tier, TierMeta> = {
  1: { heading: "Stock at risk", hex: "#b91c1c", badge: "badge badge-high" },
  2: { heading: "Records to fix", hex: "#b45309", badge: "badge badge-medium" },
  3: { heading: "For information", hex: "#1d4ed8", badge: "badge badge-info" },
};

export interface VarianceLabel {
  /** Plain-English name, e.g. "Ghost Dispatch". */
  display: string;
  tier: Tier;
  /** One sentence: what could be wrong with the stock. Dashboard, not email. */
  risk: string;
  /** Imperative, verb first. "None." for tier 3. */
  action: string;
}

/**
 * Everything a label may depend on beyond the name. Both fields are persisted
 * engine values, so a label can never depend on presentation state.
 */
export interface LabelContext {
  direction?: "IN" | "OUT" | "CROSS" | null;
  jobType?: string | null;
  /**
   * The row's STORED bucket. Supply it wherever it is available: the engine can
   * downgrade a row after classifying it, and the name alone does not say so.
   */
  bucket?: "REAL" | "INFO" | null;
}

interface LabelRule {
  base: VarianceLabel;
  /** The only refinements in the system. A third needs a comment saying why. */
  refine?: (ctx: LabelContext) => VarianceLabel | undefined;
}

// ─── The labels ──────────────────────────────────────────────────────────────
// Declared once and reused, so a display name is defined in exactly one place
// and two names sharing a label cannot drift apart.

const SYSTEM_ONLY_ODOO: VarianceLabel = {
  display: "System-Only Entry",
  tier: 1,
  risk: "Odoo booked a customer movement today that nobody at the gate, on the sheet or in the app saw.",
  action: "Confirm the unit moved, or cancel the Odoo entry.",
};

const SYSTEM_ONLY_APP: VarianceLabel = {
  display: "System-Only Entry",
  tier: 1,
  risk: "Only the delivery app says this unit moved; nobody on the floor logged it.",
  action: "Confirm the unit physically left, or void the app entry.",
};

const OFF_SYSTEM_GATE: VarianceLabel = {
  display: "Off-System Movement",
  tier: 1,
  risk: "Only the guard saw this unit leave — nothing else in the business recorded it.",
  action: "Trace the unit, then record it on the sheet, the app and Odoo.",
};

const OFF_SYSTEM_SHEET: VarianceLabel = {
  display: "Off-System Movement",
  tier: 1,
  risk: "Only the ops sheet says this moved; the guard, the app and Odoo have nothing.",
  action: "Confirm the movement happened, then record it everywhere.",
};

const OFF_SYSTEM_FLOOR: VarianceLabel = {
  display: "Off-System Movement",
  tier: 1,
  risk: "The unit left the gate and neither the delivery app nor Odoo knows it went.",
  action: "Find the order, scan it in the app, post it in Odoo.",
};

const UNLOGGED_ARRIVAL_GATE: VarianceLabel = {
  display: "Unlogged Arrival",
  tier: 2,
  risk: "A unit came in past the guard and no system has it — we are holding stock the books do not show.",
  action: "Add it to the sheet and book it into Odoo.",
};

const UNLOGGED_ARRIVAL_SHEET: VarianceLabel = {
  display: "Unlogged Arrival",
  tier: 2,
  risk: "The sheet has an arrival nothing else recorded, so the count on hand is unproven.",
  action: "Confirm the unit is on the floor and book it in.",
};

const UNLOGGED_ARRIVAL_FLOOR: VarianceLabel = {
  display: "Unlogged Arrival",
  tier: 2,
  risk: "Both floor books have the arrival; the app and Odoo do not, so it is not counted as available.",
  action: "Scan it in the app and post the receipt in Odoo.",
};

const UNCLOSED_RETURN: VarianceLabel = {
  display: "Unclosed Return",
  tier: 1,
  risk: "The delivery did not happen, so the unit should be back — but nobody logged it coming in.",
  action: "Find the unit and write it into the inward register.",
};

const GHOST_DISPATCH: VarianceLabel = {
  display: "Ghost Dispatch",
  tier: 1,
  risk: "The floor says this was not delivered while the app or Odoo says it went — one of them is wrong about a unit leaving the building.",
  action: "Establish whether the unit left, then correct the record that is wrong.",
};

const DIRECTION_CONFLICT: VarianceLabel = {
  display: "Direction Conflict",
  tier: 1,
  risk: "The same unit is booked out and in on one order with nothing saying it was a swap — one of the two is probably a double count.",
  action: "Check which movement really happened and remove the other.",
};

const SAME_DAY_REPLACEMENT: VarianceLabel = {
  display: "Same-Day Replacement",
  tier: 3,
  risk: "A unit went out and its match came back on the same order the same day — the expected shape for a swap.",
  action: "None.",
};

// NEW label. "Barcode Read Error" is tier 3, so folding a genuine mis-shipment
// into it would bury it in blue: here the dispatch is proven and the UNIT is
// wrong, which is a different and worse problem than a mistyped barcode.
const WRONG_UNIT: VarianceLabel = {
  display: "Wrong Unit Moved",
  tier: 1,
  risk: "The unit scanned at handover is not the one on the order, so two units are now on the wrong records.",
  action: "Check the unit against the order and correct both records.",
};

// NEW label. Distinct from "Odoo Posting Delay" (tier 3, no action): there the
// entry exists or is coming, here it does not exist and will not appear on its
// own. Folding these together would retire the largest actionable Odoo queue.
const ODOO_ENTRY_MISSING_FLOOR: VarianceLabel = {
  display: "Odoo Entry Missing",
  tier: 2,
  risk: "The unit moved and the floor saw it, but Odoo still shows it where it was.",
  action: "Post the stock move in Odoo today.",
};

const ODOO_ENTRY_MISSING_RETURN: VarianceLabel = {
  display: "Odoo Entry Missing",
  tier: 2,
  risk: "The unit is back in the warehouse but Odoo still has the return open, so it is not counted as available.",
  action: "Close the return in Odoo today.",
};

// "Register Gap" deliberately covers every "the others confirm it, one of our
// four books has no line" case. The per-name action names WHICH book, so the
// owner reads one amber line instead of five.
const registerGap = (risk: string, action: string): VarianceLabel => ({
  display: "Register Gap",
  tier: 2,
  risk,
  action,
});

const ODOO_DELAY = (risk: string): VarianceLabel => ({
  display: "Odoo Posting Delay",
  tier: 3,
  risk,
  action: "None.",
});

const BARCODE_READ_ERROR = (risk: string): VarianceLabel => ({
  display: "Barcode Read Error",
  tier: 3,
  risk,
  action: "None.",
});

// NEW label. Not barcode text, not Odoo — a paper register spanning two days.
const LATE_PAPERWORK: VarianceLabel = {
  display: "Late Paperwork",
  tier: 3,
  risk: "The unit is fully recorded, just written on the day either side of this one.",
  action: "None.",
};

/**
 * Fallback for a name with no rule — a row written before a rename, since the
 * DB stores the string verbatim. Tier 2, never 1 or 3: an unknown must not cry
 * wolf, and must not be hidden in blue either.
 */
export const UNLABELLED: VarianceLabel = {
  display: "Unclassified",
  tier: 2,
  risk: "This item does not match any pattern we have named yet.",
  action: "Open it on the dashboard and decide what it is.",
};

// ─── The map ─────────────────────────────────────────────────────────────────
// Record<VarianceName, …> on an object literal is the real guarantee: adding a
// 23rd constant to VARIANCE without a label here FAILS THE BUILD, and the
// computed [VARIANCE.X] keys mean editing a name's text moves the key with it.
//
// The one drift a type cannot catch: persisted rows keep the OLD string after a
// rename. Any rename must ship a matching UPDATE migration (as 0010 did) or
// historical rows fall through to UNLABELLED.

export const VARIANCE_LABELS: Record<VarianceName, LabelRule> = {
  // ── Tier 1 ────────────────────────────────────────────────────────────────
  [VARIANCE.ODOO_ONLY_TODAY]: { base: SYSTEM_ONLY_ODOO },
  [VARIANCE.DT_ONLY]: { base: SYSTEM_ONLY_APP },
  [VARIANCE.FAILED_DELIVERY]: { base: UNCLOSED_RETURN },
  [VARIANCE.SHEET_NOT_DONE_BUT_POSTED]: { base: GHOST_DISPATCH },
  [VARIANCE.WRONG_SCAN]: { base: WRONG_UNIT },

  // Direction splits. Outward = a unit left and no system knows (tier 1).
  // Inward = we are holding stock the books do not show (tier 2). Same name,
  // genuinely different risk. Default when direction is absent: tier 1.
  [VARIANCE.GATE_ONLY]: {
    base: OFF_SYSTEM_GATE,
    refine: (c) => (c.direction === "IN" ? UNLOGGED_ARRIVAL_GATE : undefined),
  },
  [VARIANCE.SHEET_ONLY]: {
    base: OFF_SYSTEM_SHEET,
    refine: (c) => (c.direction === "IN" ? UNLOGGED_ARRIVAL_SHEET : undefined),
  },
  [VARIANCE.GATE_OPS_NO_DT_ODOO]: {
    base: OFF_SYSTEM_FLOOR,
    refine: (c) => (c.direction === "IN" ? UNLOGGED_ARRIVAL_FLOOR : undefined),
  },

  // The only producer of direction=CROSS, and both "Direction Conflict" and
  // "Same-Day Replacement" in the owner's vocabulary. The engine already
  // suppresses swap-typed pairs whose outward leg did not complete
  // (direction-conflict.ts), so a row that SURVIVES with a swap job type is by
  // construction a completed swap — exactly "Same-Day Replacement". Anything
  // else, including a null job type, has no swap paperwork at all.
  //
  // Caveat worth knowing: the engine reads job type across both legs but
  // persists inView.jobType ?? outView.jobType, so a pair where only the
  // OUTWARD leg carried REPLACE lands in tier 1. That errs red, which is the
  // right way to be wrong.
  [VARIANCE.REPLACEMENT_CONFIRM]: {
    base: DIRECTION_CONFLICT,
    refine: (c) =>
      isRepairEquivalent(c.jobType ?? null) || isNewRental(c.jobType ?? null)
        ? SAME_DAY_REPLACEMENT
        : undefined,
  },

  // ── Tier 2 ────────────────────────────────────────────────────────────────
  [VARIANCE.FLOOR_DT_NOT_ODOO]: { base: ODOO_ENTRY_MISSING_FLOOR },
  [VARIANCE.PICKUP_ODOO_OPEN]: { base: ODOO_ENTRY_MISSING_RETURN },

  [VARIANCE.OPS_ODOO_NO_GATE]: {
    base: registerGap(
      "The sheet, the app and Odoo all have it; only the guard's book missed the line.",
      "Remind the guard post to write every unit in the book."
    ),
  },
  [VARIANCE.OPS_ODOO_NO_DT]: {
    base: registerGap(
      "The sheet and Odoo both have the movement; the delivery app has no scan for it.",
      "Ask the team to scan every unit at handover."
    ),
  },
  [VARIANCE.DT_ODOO_NO_SHEET]: {
    base: registerGap(
      "The app and Odoo both have the movement; the ops sheet has no line for it.",
      "Add the missing line to the ops sheet."
    ),
  },
  [VARIANCE.GATE_OPS_ODOO_NO_DT]: {
    base: registerGap(
      "The guard's book, the sheet and Odoo agree; only the app scan is missing.",
      "Scan the unit in the app to close the record."
    ),
  },
  [VARIANCE.GATE_ODOO_NO_OPS_DT]: {
    base: registerGap(
      "The guard's book and Odoo confirm the movement; the sheet and the app both missed it.",
      "Write the line into the sheet and scan it in the app."
    ),
  },

  // ── Tier 3 ────────────────────────────────────────────────────────────────
  [VARIANCE.ODOO_ONLY]: {
    base: ODOO_DELAY(
      "An older Odoo entry was posted today; the floor records for it sit on the day it actually moved."
    ),
  },
  [VARIANCE.ODOO_POSTED_NEXT_DAY]: {
    base: ODOO_DELAY(
      "The floor confirmed the movement and the Odoo entry exists — it was made a day late."
    ),
  },
  [VARIANCE.OPS_DT_ODOO_PENDING]: {
    base: ODOO_DELAY(
      "The sheet and the app have the movement; Odoo has not caught up yet. Normal lag."
    ),
  },
  [VARIANCE.FIELD_MISMATCH]: {
    base: BARCODE_READ_ERROR(
      "Every record has the unit; one of them spells the barcode differently."
    ),
  },
  [VARIANCE.DUPLICATE]: {
    base: BARCODE_READ_ERROR(
      "The same barcode was written twice in one record; only one movement happened."
    ),
  },
  [VARIANCE.ADJACENT_DAY]: { base: LATE_PAPERWORK },
};

/**
 * A row the engine downgraded after classifying it.
 *
 * resolveStaleOpenVariances (lib/db/persist.ts) rewrites a stale open row to
 * bucket INFO on the next-day re-check when the gap has cleared — a late entry
 * folded in. The NAME does not change, so the label map alone would keep
 * calling it "Direction Conflict" and put a resolved item at the top of the
 * owner's chase list. Measured on 2026-07-26: 3 of 79 tier-1 items were
 * already resolved this way.
 */
const CLEARED_ON_RECHECK: VarianceLabel = {
  display: "Cleared on Re-check",
  tier: 3,
  risk: "This gap closed on its own — the missing entry was made a day late and has now been found.",
  action: "None.",
};

/** The owner-facing label for a stored variance name. Never throws. */
export function labelFor(name: string, ctx: LabelContext = {}): VarianceLabel {
  const rule = (VARIANCE_LABELS as Record<string, LabelRule | undefined>)[name];
  if (!rule) return UNLABELLED;
  const label = rule.refine?.(ctx) ?? rule.base;

  // "Chase this today" and the engine's own "not a loss" cannot both be true.
  // Where they disagree, the engine wins: it has seen a later run's evidence
  // that the label map, which reads only the name, cannot.
  if (ctx.bucket === "INFO" && label.tier === 1) return CLEARED_ON_RECHECK;

  return label;
}

export function tierOf(name: string, ctx: LabelContext = {}): Tier {
  return labelFor(name, ctx).tier;
}

/**
 * Which team owns the fix. Read THROUGH VARIANCE_META rather than re-typed
 * here, so the email, the dashboard filter and the engine can never disagree
 * about who is responsible for a given variance.
 */
export function teamFor(name: string): string {
  const slug = VARIANCE_META[name]?.responsible ?? "ops_team";
  return RESPONSIBLE_LABEL[slug] ?? "Ops team";
}

/**
 * Names that are tier 1 or 2 in at least one context — the `.in()` filter for
 * history queries, derived from the map so it cannot drift from the tiers.
 */
export const ACTIONABLE_NAMES: string[] = Object.entries(VARIANCE_LABELS)
  .filter(([, r]) => {
    const tiers = [r.base.tier, r.refine?.({ direction: "IN" })?.tier].filter(
      (t): t is Tier => t != null
    );
    return tiers.some((t) => t < 3);
  })
  .map(([name]) => name);
