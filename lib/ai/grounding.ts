// What a tool is allowed to say it found, and how absence is described.
//
// The single hardest thing about this feature is that "no rows" has at least
// four different meanings here, and three of them are not "the unit did not
// move". Collapsing them is how an assistant ends up telling a warehouse
// manager a unit is missing when the record was simply pruned.
//
// This module is also where internal vocabulary is stripped. Tool payloads are
// translated through lib/ui/variance-labels before the model ever sees them, so
// `variance_name`, `bucket` and `priority` are structurally absent rather than
// merely discouraged by the prompt.

import { labelFor, teamFor, TIER, type Tier } from "../ui/variance-labels";
import { sanitizeFreeText } from "./sanitize";

export type ToolStatus =
  /** Rows came back. Narrate them. */
  | "found"
  /**
   * Systems recorded the unit in-window, a run covered that city-day, and
   * nothing was flagged. The ONLY status that licenses "this moved cleanly".
   */
  | "clean"
  /** In retention, the run covered those days, and no system had a row. */
  | "no_record_in_window"
  /** The question reaches before the retention floor. Not the same thing. */
  | "no_detail_retained"
  /** A spare, consumable or PP box: counted in bulk, never tracked per unit. */
  | "count_only"
  | "invalid_barcode"
  /** The caller cannot see the city they asked about. */
  | "city_not_visible"
  | "lookup_failed";

export const SOURCE_NAMES = {
  P: "gate register",
  S: "ops sheet",
  D: "delivery app",
  O: "Odoo",
} as const;
export type SourceKey = keyof typeof SOURCE_NAMES;
const KEYS: SourceKey[] = ["P", "S", "D", "O"];

export interface PresenceRow {
  present_p?: boolean | null;
  present_s?: boolean | null;
  present_d?: boolean | null;
  present_o?: boolean | null;
  reported_p?: boolean | null;
  reported_s?: boolean | null;
  reported_d?: boolean | null;
  reported_o?: boolean | null;
}

export interface Evidence {
  /** Systems that confirmed this unit. */
  recordedBy: string[];
  /** Systems that were up and genuinely had nothing. */
  noEntryIn: string[];
  /** Systems that did not report at all — their silence proves nothing. */
  cannotJudge: string[];
  /**
   * False when the row carries no per-system detail (written before migration
   * 0013). All three arrays are then EMPTY, so it is structurally impossible to
   * render four crosses against sources nobody asked.
   */
  evidenceHeld: boolean;
}

const get = (row: PresenceRow, k: SourceKey, kind: "present" | "reported"): boolean =>
  row[`${kind}_${k.toLowerCase()}` as keyof PresenceRow] === true;

/**
 * Turn the per-source flags into three named lists.
 *
 * The distinction between `noEntryIn` and `cannotJudge` is the whole reason
 * migrations 0012 and 0013 store `reported_*` alongside `present_*`: a source
 * that was DOWN must never be reported as a source that had no record. One is
 * evidence; the other is the absence of evidence.
 */
export function describeEvidence(row: PresenceRow): Evidence {
  // Every row the engine emits has at least one source present, so all-false is
  // the "written before 0013" sentinel — the row knows nothing, and saying so
  // is the only honest option.
  const evidenceHeld = KEYS.some((k) => get(row, k, "present"));
  if (!evidenceHeld) {
    return { recordedBy: [], noEntryIn: [], cannotJudge: [], evidenceHeld: false };
  }

  const recordedBy: string[] = [];
  const noEntryIn: string[] = [];
  const cannotJudge: string[] = [];
  for (const k of KEYS) {
    const name = SOURCE_NAMES[k];
    if (get(row, k, "present")) recordedBy.push(name);
    else if (get(row, k, "reported")) noEntryIn.push(name);
    else cannotJudge.push(name);
  }
  return { recordedBy, noEntryIn, cannotJudge, evidenceHeld: true };
}

export interface FlaggedItem {
  problem: string;
  severity: string;
  why: string;
  action: string;
  team: string;
  state: string;
  tier: Tier;
}

const STATE_WORDS: Record<string, string> = {
  open: "open",
  in_progress: "being worked on",
  pending_approval: "waiting for approval",
  closed: "closed",
};

/**
 * Translate a stored variance row into the owner-facing vocabulary.
 *
 * `bucket` is passed through to labelFor deliberately: the engine can downgrade
 * a row after classifying it (the next-day re-check folding in a late entry),
 * and the name alone does not say so. Without it the assistant would put a
 * resolved item at the top of someone's chase list.
 */
export function describeFlag(row: {
  variance_name: string;
  direction?: string | null;
  job_type?: string | null;
  bucket?: string | null;
  status?: string | null;
  responsible?: string | null;
  note?: string | null;
}): FlaggedItem {
  const label = labelFor(row.variance_name, {
    direction: (row.direction as "IN" | "OUT" | "CROSS" | null) ?? null,
    jobType: row.job_type ?? null,
    bucket: (row.bucket as "REAL" | "INFO" | null) ?? null,
    note: row.note ?? null,
  });
  return {
    problem: label.display,
    severity: TIER[label.tier].heading,
    why: label.risk,
    action: label.action,
    team: teamFor(row.variance_name),
    state: STATE_WORDS[row.status ?? "open"] ?? "open",
    tier: label.tier,
  };
}

export const DIRECTION_WORDS: Record<string, string> = {
  IN: "arrived",
  OUT: "left",
  CROSS: "both arrived and left",
};

/** Free-text carried from source systems, capped and neutralised. */
export function describeOrder(row: {
  so_number?: string | null;
  ticket_id?: string | null;
  product?: string | null;
  customer?: string | null;
  job_type?: string | null;
}): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v: string | null) => {
    if (v) out[k] = v;
  };
  put("so", sanitizeFreeText(row.so_number, 40));
  put("ticket", sanitizeFreeText(row.ticket_id, 40));
  put("product", sanitizeFreeText(row.product, 80));
  put("customer", sanitizeFreeText(row.customer, 60));
  put("jobType", sanitizeFreeText(row.job_type, 40));
  return out;
}
