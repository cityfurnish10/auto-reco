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
  createdOn?: string | number; // Odoo (Section 4)
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
  // as false Odoo-only rows (each posting is judged once, in its own day's run).
  odooSameDay: boolean;
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
}

export interface CountLayer {
  primary_source: "PHYSICAL" | "SHEET";
  expected: number;
  dt_done: number;
  dt_diff: number;
  odoo_count: number;
  odoo_diff: number;
  phys_total: number;
  sheet_total: number;
  phys_sheet_match: boolean;
  phys_sheet_diff: number;
}

export interface CityRunResult {
  city: City;
  date: string;
  variances: VarianceRowOut[];
  real_variances: VarianceRowOut[];
  info_variances: VarianceRowOut[];
  count_in: CountLayer;
  count_out: CountLayer;
  summary: {
    total: number;
    real_count: number;
    info_count: number;
    high_priority: number;
    medium_priority: number;
    by_variance: Record<string, number>;
  };
  warnings: string[];
}
