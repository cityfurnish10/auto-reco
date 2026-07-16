// Background OCR processor — turns uploaded guard-register PDFs into stored rows
// with NO human review step. This is the whole "upload → OCR → store" pipeline:
//
//   guard_uploads (status='pending', file in Storage)
//     → download PDF → Azure Read (submit + poll, server-side)
//     → reconstruct every page's grid (stored RAW, unfiltered)
//     → status='processed', parsed_rows saved
//
// The reconcile cron's guard connector then reads status='processed' rows for
// the run date, same as the other three sources. Runs from /api/cron/ocr (its
// own background job) and, as a safety net, at the start of the reconcile cron.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  analyzeLayout,
  guardRowsFromLayout,
  azureDocIntelConfigured,
} from "./document-intelligence";
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
}

export interface OcrProcessSummary {
  processed: number;
  failed: number;
  skipped: number;
  details: OcrProcessDetail[];
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
    try {
      const { data: blob, error: dErr } = await admin.storage.from(BUCKET).download(u.file_path);
      if (dErr || !blob) {
        // File not uploaded yet (or gone) — leave pending, retry next run.
        summary.skipped++;
        summary.details.push({ id: u.id, file: u.file_name, city: u.city, result: "skipped", reason: "file not in storage yet" });
        continue;
      }

      const bytes = new Uint8Array(await blob.arrayBuffer());
      const rows = await ocrPdfToRows(bytes);
      const rowsValid = rows.filter((r) => r.cells?.barcode?.trim() && r.direction).length;

      const { error: upErr } = await admin
        .from("guard_uploads")
        .update({
          status: "processed",
          parsed_rows: rows, // stored RAW — reconcile's guard connector filters downstream
          ocr_raw_snapshot: rows,
          rows_parsed: rows.length,
          rows_valid: rowsValid,
          error: null,
        })
        .eq("id", u.id);
      if (upErr) throw new Error(upErr.message);

      summary.processed++;
      summary.details.push({ id: u.id, file: u.file_name, city: u.city, result: "processed", rows: rows.length });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await admin.from("guard_uploads").update({ status: "failed", error: reason }).eq("id", u.id).then(() => {});
      summary.failed++;
      summary.details.push({ id: u.id, file: u.file_name, city: u.city, result: "failed", reason });
    }
  }

  return summary;
}
