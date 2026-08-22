// TypeScript types mirroring the Supabase tables (0001_init.sql).
// Used by API routes, persist.ts, and frontend data hooks.

import type { City } from "../sample-data";

// ─── app_users ──────────────────────────────────────────────────────────────
// "guard" (0023) scans at the gate and has no dashboard access — gated in
// middleware.ts, not here.
export type UserRole = "admin" | "manager" | "viewer" | "guard";

export interface AppUser {
  id: string;
  auth_id: string | null;
  email: string;
  name: string;
  role: UserRole;
  city: City | null;
  status: "active" | "inactive";
  created_at: string;
  updated_at: string;
}

// ─── reconciliation_runs ────────────────────────────────────────────────────
export type RunStatus = "running" | "success" | "partial" | "failed";
export type RunTrigger = "cron" | "manual";

export interface ReconciliationRun {
  id: string;
  business_date: string;          // DATE as ISO string
  run_date: string | null;        // engine-derived
  trigger: RunTrigger;
  triggered_by: string | null;
  status: RunStatus;
  total: number;
  real_count: number;
  info_count: number;
  high_priority: number;
  by_variance: Record<string, number>;
  warnings: string[];
  created_at: string;
  completed_at: string | null;
}

// ─── source_rows ────────────────────────────────────────────────────────────
export type SourceKind = "PHYSICAL" | "SHEET" | "DT" | "ODOO";
export type Direction = "IN" | "OUT";

export interface SourceRowDB {
  id: string;
  run_id: string;
  business_date: string;
  source: SourceKind;
  city: City;
  direction: Direction;
  barcode: string;
  status: string | null;
  so_number: string | null;
  ticket_id: string | null;
  customer: string | null;
  product: string | null;
  job_type: string | null;
  date: string | null;
  created_on: string | null;
  movement_date: string | null;
  raw: Record<string, unknown> | null;
  created_at: string;
}

// ─── variances ──────────────────────────────────────────────────────────────
export type Priority = "High" | "Medium" | "Info";
export type Bucket = "REAL" | "INFO";
export type VarianceStatus = "open" | "in_progress" | "pending_approval" | "closed";
export type VarianceSource = "Odoo" | "DT" | "Sheet" | "Physical" | "Cross";
export type OutputDirection = Direction | "CROSS";

export interface VarianceDB {
  id: string;
  run_id: string;
  business_date: string;
  city: City;
  direction: OutputDirection;
  /** CANONICAL — the dedup key and the join to source_rows.barcode_canonical. */
  barcode: string;
  /**
   * The spelling a typed source actually recorded (migration 0020). Optional:
   * absent before the migration is applied and NULL on rows written before it,
   * which is why every reader goes through shownBarcode() rather than reading
   * this directly.
   */
  barcode_display?: string | null;
  variance_name: string;

  // Engine-derived
  priority: Priority;
  original_priority: Priority | null;
  bucket: Bucket;
  dampened: boolean;
  responsible: string;
  variance_source: VarianceSource | null;
  note: string | null;

  // Identifying detail
  ticket_id: string | null;
  so_number: string | null;
  customer: string | null;
  product: string | null;
  job_type: string | null;
  date: string;

  // Timestamps
  first_seen_at: string;
  last_seen_at: string;

  // Human resolution
  status: VarianceStatus;
  closed_by: string | null;
  closed_at: string | null;
  closure_reason: string | null;
  closure_note: string | null;

  // Approval workflow (0009): manager submits → admin approves/rejects.
  submitted_by: string | null;
  submitted_at: string | null;
  submit_reason: string | null;
  submit_note: string | null;
  rejection_note: string | null;

  // Per-source presence (0013). Optional because migrations here are applied by
  // hand: rows written before it keep all-false, and the columns are absent
  // from the response entirely until it is applied. All four present_* false
  // means "not recorded for this date" — never render four crosses.
  present_p?: boolean;
  present_s?: boolean;
  present_d?: boolean;
  present_o?: boolean;
  reported_p?: boolean;
  reported_s?: boolean;
  reported_d?: boolean;
  reported_o?: boolean;

  created_at: string;
  updated_at: string;
}

// ─── scheduled_emails (0009) ─────────────────────────────────────────────────
export type ScheduledEmailStatus =
  | "pending"
  | "sending"
  | "sent"
  | "skipped"
  | "canceled"
  | "failed";

export interface ScheduledEmailDB {
  id: string;
  kind: "digest" | "follow_up";
  business_date: string;
  send_at: string;
  status: ScheduledEmailStatus;
  require_resolved: boolean;
  recipients: string[];
  cc: string[];
  bcc: string[];
  notes: string | null;
  attempts: number;
  last_error: string | null;
  scheduled_by: string | null;
  email_log_id: string | null;
  /**
   * kind='follow_up' only: the email_logs row whose `totals` snapshot supplies
   * X. Pinned at enqueue rather than looked up at send time — an admin can
   * re-send a day, and the follow-up must quote the send it was queued against.
   */
  source_email_log_id?: string | null;
  created_at: string;
  updated_at: string;
}

// ─── ingestion_logs ─────────────────────────────────────────────────────────
export type IngestionStatus = "OK" | "FAILED";

export interface IngestionLog {
  id: string;
  run_id: string;
  source: SourceKind;
  status: IngestionStatus;
  rows_pulled: number;
  message: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  created_at: string;
}

// ─── guard_uploads ──────────────────────────────────────────────────────────
// 5-state flow: pending -> ocr_running -> needs_review -> processed (or failed
// at any point). direction is nullable now — a single PDF has both IN and OUT
// pages, so direction lives per-row inside parsed_rows, not on the upload itself.
export type UploadStatus =
  | "pending"
  | "ocr_running"
  | "needs_review"
  | "processed"
  | "failed";

// One reconstructed body row from a page of the register. `direction` is the
// page-level direction (OUT/IN) detected from the printed register title.
export interface ParsedGuardRow {
  page: number;
  rowIndex: number;
  direction: Direction | null;
  // keyed by the guard columns produced in lib/connectors/ocr/document-intelligence.ts:
  // date, so_number, ticket_id, product, po_number, barcode, operation_type.
  cells: Record<string, string>;
  confidence: number | null;
}

export interface GuardUpload {
  id: string;
  run_id: string | null;
  uploaded_by: string | null;
  file_name: string;
  file_path: string;
  city: City;
  business_date: string;
  direction: Direction | null;
  rows_parsed: number;
  rows_valid: number;
  ocr_confidence: number | null;
  parsed_rows: ParsedGuardRow[] | null; // reviewer-confirmed once status=processed
  ocr_raw_snapshot: ParsedGuardRow[] | null; // immutable pre-correction OCR output
  ocr_operation_id: string | null; // Azure async operation URL, while ocr_running
  reviewed_by: string | null;
  reviewed_at: string | null;
  status: UploadStatus;
  error: string | null;
  created_at: string;
}

// ─── Gate control (0023 / 0024) ─────────────────────────────────────────────
// The digital gate register. These mirror the tables that replace the
// handwritten book — see supabase/migrations/0023_gate_movement_log.sql.
//
// NOTE ON `barcode`: unlike everywhere else in this file, a gate barcode is the
// RAW QR payload and is never the canonical fold. It is a label and an Odoo
// lookup key, not a matching key; canonicalization happens downstream.

export type TripStatus = "open" | "closed" | "abandoned";
/** How the identifier reached us. Only `qr` carries a checksum guarantee. */
export type BarcodeSource = "qr" | "manual" | "pending";
export type GateEntryMethod = "scan" | "manual";
/**
 * What kind of thing crossed the gate. Two families:
 *
 * IDENTIFIED — a specific unit, always quantity 1 (except an untagged vendor
 *   batch): `unit` (tagged, scanned), `vendor_goods` (inward only, tagged after
 *   receipt), `customer_return` (inward only; an untagged one is an alert).
 * COUNTED — no serial exists or is expected, the quantity is the whole record:
 *   `spare_part`, `consumable`, `pp_box`, `sample`.
 */
export type GateItemKind =
  | "unit"
  | "vendor_goods"
  | "customer_return"
  | "spare_part"
  | "consumable"
  | "pp_box"
  | "sample"
  | "other";

/** Kinds with no serial — a quantity is the entire record. */
export const COUNTED_KINDS: readonly GateItemKind[] = [
  "spare_part",
  "consumable",
  "pp_box",
  "sample",
];

/** Offered in the app's manual-entry dropdown, per direction. */
export const MANUAL_KINDS: Record<Direction, readonly GateItemKind[]> = {
  IN: ["vendor_goods", "customer_return", "spare_part", "consumable", "pp_box", "sample"],
  OUT: ["spare_part", "consumable", "pp_box", "sample"],
};
export type GateScanStatus = "recorded" | "void";
/** Result of checking a scan against the day's expected pickings. */
export type ExpectedMatch = "expected" | "not_listed" | "unchecked";

/** A phone enrolled at a gate. Belongs to the SITE, not to a person. */
export interface GateDevice {
  id: string;
  city: City;
  site_code: string;
  device_id: string;
  device_label: string | null;
  /** Never sent to the client. What the sync endpoint authenticates. */
  token_hash?: string;
  status: "active" | "revoked";
  revoked_at: string | null;
  last_seen_at: string | null;
  created_by: string | null;
  created_at: string;
}

/** A guard's own sign-in. They may use any active device in their city. */
export interface GuardProfile {
  id: string;
  guard_id: string;
  city: City;
  /** Never sent to the client — the PIN is a local unlock. */
  pin_hash?: string;
  /** Kept for human review only — never sent to a phone. */
  reference_photo: string | null;
  /** 128-float face signature. THIS is what devices receive, not the photo. */
  reference_descriptor: number[] | null;
  consent_at: string | null;
  employee_code: string | null;
  phone: string | null;
  status: "active" | "inactive";
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface GateTrip {
  id: string;
  client_trip_id: string;
  city: City;
  site_code: string;
  direction: Direction;
  /** NOT NULL — every movement travels on a vehicle. */
  vehicle_no: string;
  driver_name: string | null;
  carrier_ref: string | null;
  opened_at: string;
  closed_at: string | null;
  /** Server-derived from opened_at on the 15:00→15:00 business day. */
  business_date: string;
  guard_id: string | null;
  device_id: string | null;
  status: TripStatus;
  notes: string | null;
  created_at: string;
}

export interface GateScan {
  id: string;
  /** Device-generated idempotency key. Re-sending it is a no-op. */
  client_scan_id: string;
  trip_id: string | null;
  city: City;
  site_code: string;
  direction: Direction;
  business_date: string;

  /** RAW QR payload. Null only for untagged inward awaiting its sticker. */
  barcode: string | null;
  barcode_source: BarcodeSource;
  serial_no: string | null;

  item_kind: GateItemKind;
  quantity: number;
  entry_method: GateEntryMethod;

  product: string | null;
  so_number: string | null;
  ticket_id: string | null;
  customer: string | null;

  photo_path: string | null;
  photo_sampled: boolean;

  lat: number | null;
  lng: number | null;
  accuracy_m: number | null;
  /** Null means no fix was available — not a failure. */
  geo_ok: boolean | null;

  scanned_at: string;
  received_at: string;
  guard_id: string | null;
  device_id: string | null;

  expected_match: ExpectedMatch | null;
  override_reason: string | null;

  barcode_pending: boolean;
  linked_barcode: string | null;
  linked_at: string | null;
  linked_by: string | null;

  exception_reason: string | null;
  status: GateScanStatus;
  void_reason: string | null;
  voided_by: string | null;
  voided_at: string | null;
  notes: string | null;
  created_at: string;
}

export interface GateExpectedItem {
  id: string;
  city: City;
  business_date: string;
  direction: Direction;
  /** As Odoo spells it. */
  barcode: string;
  /** The fold, so a scan still matches a differently-spelled Odoo row. */
  barcode_canon: string;
  product: string | null;
  so_number: string | null;
  ticket_id: string | null;
  customer: string | null;
  picking_ref: string | null;
  job_type: string | null;
  refreshed_at: string;
}

// ─── Attendance (0024) ──────────────────────────────────────────────────────

export type ShiftStatus = "open" | "closed" | "auto_closed";
export type FaceTrigger = "check_in" | "check_out" | "random";
/** `skipped` is an unanswered prompt — visible as unanswered, not a mismatch. */
export type FaceVerdict = "pass" | "review" | "fail" | "no_face" | "skipped";
export type FaceReviewState = "none" | "pending" | "accepted" | "rejected";

export interface GuardShift {
  id: string;
  client_shift_id: string;
  guard_id: string;
  city: City;
  site_code: string;
  device_id: string | null;
  checked_in_at: string;
  checked_out_at: string | null;
  business_date: string;
  in_lat: number | null;
  in_lng: number | null;
  in_geo_ok: boolean | null;
  out_lat: number | null;
  out_lng: number | null;
  out_geo_ok: boolean | null;
  status: ShiftStatus;
  auto_closed_reason: string | null;
  notes: string | null;
  created_at: string;
}

export interface GuardFaceCheck {
  id: string;
  client_check_id: string;
  shift_id: string | null;
  guard_id: string;
  city: City;
  device_id: string | null;
  trigger: FaceTrigger;
  captured_at: string;
  received_at: string;
  /** Kept for human dispute review — NOT what the match ran against. */
  selfie_path: string | null;
  /** Raw on-device similarity, stored so a bad threshold can be re-judged. */
  match_score: number | null;
  verdict: FaceVerdict;
  lat: number | null;
  lng: number | null;
  geo_ok: boolean | null;
  review_state: FaceReviewState;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
}
