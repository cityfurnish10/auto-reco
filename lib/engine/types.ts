// Reconciliation engine types — modelled directly on the Cityfurnish
// Warehouse Stock Reconciliation spec (reconciliation_logic_prompt.md).
// The engine is barcode-level and per-direction; quantities are not used
// for the per-barcode variance layer (only the aggregate count layer).

import type { City } from "../sample-data";

export type Direction = "IN" | "OUT";
export type OutputDirection = Direction | "CROSS";
export type SourceKind = "PHYSICAL" | "SHEET" | "DT" | "ODOO";

// City codes the Odoo-window rules are written against (Section 4).
export type CityCode = "GUR" | "PUN" | "BAN" | "MUM" | "HYD";

// One raw row from one source. Physical/DT rows drive run-date derivation;
// Odoo rows carry createdOn/jobType for windowing + repair suppression.
export interface SourceRow {
  source: SourceKind;
  direction: Direction;
  barcode: string; // as recorded (pre-canonicalization)
  date?: string | number; // physical & DT date fields (Section 3)
  status?: string; // DT: done|pending|not_done|non_match ; sheet: done
  soNumber?: string;
  ticketId?: string;
  customer?: string;
  product?: string;
  jobType?: string; // Odoo job_type: REPAIR|REPLACE|NEW_RENTAL|...
  // Ops-sheet free-text remarks column, when the sheet has one. Read only as a
  // spare/consumable/PP-box hint (see run.ts); never used for matching.
  remarks?: string;
  createdOn?: string | number; // Odoo posting date (Section 4 window key)
  recordCreatedOn?: string | number; // Odoo create_date (record birth; Odoo-only flag)
  movementDate?: string | number; // Odoo fallback
}

export type NormStatus =
  | "done"
  | "pending"
  | "not_done"
  | "non_match"
  | "unknown";

export interface SourcePresence {
  present: boolean;
  count: number; // rows for this canonical in this source+direction
  statuses: NormStatus[];
  rawBarcodes: string[]; // distinct raw spellings that folded to this canonical
}

// Which sources actually reported for this city+run (connector OK and ≥1 row
// for the city). An unreported source's absence is uninformative — the ladder
// must not blame it (source outage / data-entry lag would otherwise flood the
// dashboard with false HIGH variances). Default: all true (sample/demo data).
export interface ReportedSources {
  P: boolean; // PHYSICAL / guard register
  S: boolean; // SHEET
  D: boolean; // DT
  O: boolean; // ODOO
}

export const ALL_REPORTED: ReportedSources = { P: true, S: true, D: true, O: true };

// Which sources CONFIRMED one particular unit. Structurally identical to
// ReportedSources and deliberately named apart: this answers "did this source
// see the unit", ReportedSources answers "did this source report at all". The
// UI needs both — a source that was down must render as "no data", not as a
// cross that blames it for an absence it never had the chance to fill.
export interface SourceFlags {
  P: boolean; // PHYSICAL / guard register
  S: boolean; // SHEET / ops register
  D: boolean; // DT / delivery app
  O: boolean; // ODOO
}

export interface BarcodeView {
  canonical: string;
  direction: Direction;
  city: City;
  P: SourcePresence;
  S: SourcePresence;
  D: SourcePresence;
  O: SourcePresence;
  // True when at least one Odoo row for this barcode was POSTED on the run
  // date itself (createdOn == runDate). The Odoo pull spans ±1 day of postings
  // to catch posting lag; an "Odoo-only" variance may only fire for same-day
  // postings, so neighbours' movements pulled as match-targets never surface
  // as false Odoo-only rows (each posting is judged at most once, in its own
  // day's run — and not at all when a floor source documented the unit on a
  // nearby day, where the movement was already reconciled; see run.ts).
  odooSameDay: boolean;
  // True when at least one Odoo posting for this barcode is dated runDate + 1 —
  // the 1-day late-entry buffer. A floor-confirmed movement whose only Odoo
  // evidence is a next-day posting is an "entry made late" INFO, never a REAL
  // "not posted in Odoo".
  odooNextDay: boolean;
  // REAL-eligibility gate for the Odoo-only rung (stamped in run.ts as a
  // composite): the Odoo record was CREATED (create_date) on the run date
  // itself, it is a CUSTOMER flow (sale order present, not an /INT/ internal
  // transfer), and the floor has no trace of the unit on nearby days. Only then
  // is an Odoo-only row a genuine same-day movement the floor missed (REAL);
  // otherwise it is a late batch-post / vendor receipt / internal transfer /
  // backlog entry (INFO).
  odooCreatedToday: boolean;
  soNumber: string | null;
  ticketId: string | null;
  customer: string | null;
  product: string | null;
  jobType: string | null; // normalized (uppercased) Odoo job type
  date: string;
  dtNonMatch: boolean; // any DT row status = non_match (Section 6 top rule)
  duplicateSources: SourceKind[]; // sources where count > 1
}

export type Priority = "High" | "Medium" | "Info";
export type Bucket = "REAL" | "INFO";

export interface VarianceRowOut {
  barcode: string;
  /**
   * The raw spelling a typed system recorded — what a human should see and
   * what they can paste into Odoo. `barcode` above stays the canonical, because
   * it is half the variances dedup key. See views.ts displayBarcode().
   */
  barcode_display: string;
  city: City;
  direction: OutputDirection;
  variance_name: string;
  priority: Priority;
  original_priority?: Priority;
  bucket: Bucket;
  dampened?: boolean;
  responsible: string;
  ticket_id: string | null;
  so_number: string | null;
  customer: string | null;
  product: string | null;
  job_type: string | null;
  date: string;
  note: string;
  // Which sources confirmed this unit. REQUIRED, not optional, on purpose:
  // that is what makes `tsc --noEmit` fail at every row-construction site
  // until each supplies it — including the bulk-SO rewrite in run.ts, which
  // rebuilds the row field by field and would otherwise drop it in silence.
  present: SourceFlags;
  // Which sources reported for this city+run at all. Uniform across a run, so
  // it is stamped once in runReconciliation rather than threaded through every
  // construction site.
  reported: SourceFlags;
}

export interface CountLayer {
  primary_source: "PHYSICAL" | "SHEET";
  expected: number;
  dt_done: number;
  dt_diff: number;
  odoo_count: number;
  /**
   * Postings dated the run date ITSELF — what the digest reports.
   *
   * odoo_count is the reconciliation window (run-1 .. run+1), deliberately
   * wide so a next-day posting matches the day's movement. Reporting that as
   * "Odoo" stacked three days into one column and dwarfed every other book.
   */
  odoo_same_day: number;
  odoo_diff: number;
  phys_total: number;
  sheet_total: number;
  /** All DT rows, unlike dt_done which counts only completed ones. */
  dt_total: number;
  phys_sheet_match: boolean;
  phys_sheet_diff: number;
}

/**
 * One movement of one unit, whatever the outcome — the row `variances` cannot
 * carry because it only records problems.
 *
 * `present` MUST be read at emit time, not while views are being built:
 * mergeGuardPresence mutates target.P during the OCR-orphan fold, so an early
 * snapshot reports "no gate record" for exactly the units the merge repaired.
 */
export interface MovementEvent {
  barcode: string; // canonical — the ledger's key
  /** The raw spelling a typed system recorded. See views.ts displayBarcode(). */
  barcode_display: string;
  city: City;
  direction: Direction;
  date: string;
  present: SourceFlags;
  reported: SourceFlags;
  odooSameDay: boolean;
  odooNextDay: boolean;
  odooCreatedToday: boolean;
  /** run.ts's isMovement: P || S || D || odooSameDay. */
  isMovement: boolean;
  jobType: string | null;
  soNumber: string | null;
  ticketId: string | null;
  customer: string | null;
  product: string | null;
  outcome: "CLEAN" | "INFO" | "REAL" | "SUPPRESSED";
  varianceNames: string[];
  worstPriority: Priority | null;
  suppressedReason:
    | "dt_all_pending"
    | "silent_ocr"
    | "failed_delivery_return"
    /**
     * An Odoo-only posting for a unit a FLOOR source documented on a nearby
     * day. The ±1 posting window pulls one Odoo row into three runs; on the two
     * neighbouring days it has no floor company and used to file a variance
     * against a movement already reconciled on its own day. See run.ts.
     *
     * Migration 0021 adds this to the movement_events CHECK. persist.ts stores
     * it as "other" on a database that does not have 0021 yet.
     */
    | "odoo_nearby_day"
    | "other"
    | null;
}

export interface CityRunResult {
  city: City;
  date: string;
  variances: VarianceRowOut[];
  real_variances: VarianceRowOut[];
  info_variances: VarianceRowOut[];
  count_in: CountLayer;
  count_out: CountLayer;
  /**
   * Every movement this run saw, clean or not (migration 0015). REQUIRED, not
   * optional: the compiler is what guarantees a new construction site cannot
   * quietly omit it, the same way VarianceRowOut.present is required.
   */
  movement_events: MovementEvent[];
  summary: {
    total: number;
    real_count: number;
    info_count: number;
    high_priority: number;
    medium_priority: number;
    // Total distinct directional movements (IN + OUT reconciliation universe) —
    // the accuracy-rate denominator for the leaderboard.
    movements: number;
    // Count-only movements surfaced separately (not in the variance list).
    pp_box_count: number;
    consumable_count: number;
    by_variance: Record<string, number>;
  };
  warnings: string[];
}
