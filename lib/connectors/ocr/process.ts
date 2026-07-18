// Background OCR processor — turns uploaded guard-register PDFs into stored rows
// with NO human review step. This is the whole "upload → OCR → store" pipeline:
//
//   guard_uploads (status='pending', file in Storage)
//     → download PDF → Azure Read (submit + poll, server-side)
//     → reconstruct every page's grid (stored RAW, unfiltered)
//     → status='processed', parsed_rows saved
//
// The reconcile cron's guard connector then reads status='processed' rows for
// the run date, same as the other three sources. OCR runs IMMEDIATELY on upload
// (/api/uploads/guard/[id]/process), with a safety-net pass at the start of the
// reconcile cron and an on-demand batch job (/api/cron/ocr).

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  analyzeLayout,
  guardRowsFromLayout,
  azureDocIntelConfigured,
} from "./document-intelligence";
import { mirrorGuardPdf } from "../drive";
import type { GuardUpload, ParsedGuardRow } from "../../db/schema";

const BUCKET = "guard-registers";

// OCR a register PDF via Azure Document Intelligence (Layout) and turn its
// tables into guard rows. Stores everything raw — no confidence/empty-row
// filtering (per product call); the reconcile engine drops invalid barcodes.
async function ocrPdfToRows(pdf: Uint8Array): Promise<ParsedGuardRow[]> {
  const layout = await analyzeLayout(pdf);
  return guardRowsFromLayout(layout);
}

export interface OcrProcessDetail {
  id: string;
  file: string;
  city?: string;
  result: "processed" | "failed" | "skipped";
  rows?: number;
  reason?: string;
  drive?: "uploaded" | "exists" | "skipped" | "failed"; // Drive mirror outcome
}

export interface OcrProcessSummary {
  processed: number;
  failed: number;
  skipped: number;
  details: OcrProcessDetail[];
}

// OCR one guard upload: download its PDF, run Document Intelligence, store the
// rows, mark it processed (or failed). Used both immediately on upload (the
// /api/uploads/guard/[id]/process route) and by the batch job below.
export async function processGuardUpload(
  admin: SupabaseClient,
  upload: GuardUpload
): Promise<OcrProcessDetail> {
  const base = { id: upload.id, file: upload.file_name, city: upload.city };
  try {
    const { data: blob, error: dErr } = await admin.storage.from(BUCKET).download(upload.file_path);
    if (dErr || !blob) {
      return { ...base, result: "skipped", reason: "file not in storage yet" };
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const rows = await ocrPdfToRows(bytes);
    const rowsValid = rows.filter((r) => r.cells?.barcode?.trim() && r.direction).length;
    const { error: upErr } = await admin
      .from("guard_uploads")
      .update({
        status: "processed",
        parsed_rows: rows, // stored RAW — the reconcile guard connector filters downstream
        ocr_raw_snapshot: rows,
        rows_parsed: rows.length,
        rows_valid: rowsValid,
        error: null,
      })
      .eq("id", upload.id);
    if (upErr) throw new Error(upErr.message);

    // Best-effort mirror to Google Drive (Supabase stays the source of truth).
    // Reuses the bytes we already downloaded; never fails the OCR — a Drive
    // misconfig/quota/network error only produces a logged warning.
    const mirror = await mirrorGuardPdf(bytes, upload.city, upload.file_name, upload.id);
    if (mirror.status === "failed") {
      console.warn(`[guard ${upload.id}] Drive mirror failed: ${mirror.reason}`);
    }
    return { ...base, result: "processed", rows: rows.length, drive: mirror.status };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await admin.from("guard_uploads").update({ status: "failed", error: reason }).eq("id", upload.id).then(() => {});
    return { ...base, result: "failed", reason };
  }
}

// Process every 'pending' guard upload (optionally scoped to one business date).
// A pending row whose file isn't in Storage yet is skipped (left pending) so the
// next run retries it — never a hard failure.
export async function processPendingGuardUploads(
  admin: SupabaseClient,
  opts: { businessDate?: string; limit?: number } = {}
): Promise<OcrProcessSummary> {
  const summary: OcrProcessSummary = { processed: 0, failed: 0, skipped: 0, details: [] };

  if (!azureDocIntelConfigured()) {
    summary.details.push({ id: "-", file: "-", result: "skipped", reason: "Azure Document Intelligence not configured" });
    return summary;
  }

  let query = admin
    .from("guard_uploads")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true });
  if (opts.businessDate) query = query.eq("business_date", opts.businessDate);
  if (opts.limit) query = query.limit(opts.limit);

  const { data, error } = await query;
  if (error) throw new Error(`processPendingGuardUploads query failed: ${error.message}`);
  const uploads = (data ?? []) as GuardUpload[];

  for (const u of uploads) {
    const detail = await processGuardUpload(admin, u);
    summary.details.push(detail);
    if (detail.result === "processed") summary.processed++;
    else if (detail.result === "failed") summary.failed++;
    else summary.skipped++;
  }

  return summary;
}
