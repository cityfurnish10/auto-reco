// TypeScript types mirroring the Supabase tables (0001_init.sql).
// Used by API routes, persist.ts, and frontend data hooks.

import type { City } from "../sample-data";

// ─── app_users ──────────────────────────────────────────────────────────────
export type UserRole = "admin" | "manager" | "viewer";

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
export type VarianceStatus = "open" | "in_progress" | "closed";
export type VarianceSource = "Odoo" | "DT" | "Sheet" | "Physical" | "Cross";
export type OutputDirection = Direction | "CROSS";

export interface VarianceDB {
  id: string;
  run_id: string;
  business_date: string;
  city: City;
  direction: OutputDirection;
  barcode: string;
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
// page-level guess/override — see lib/connectors/ocr/direction-detect.ts.
export interface ParsedGuardRow {
  page: number;
  rowIndex: number;
  direction: Direction | null;
  cells: Record<string, string>; // keyed by lib/connectors/ocr/table-reconstruct.ts's GUARD_COLUMNS
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
