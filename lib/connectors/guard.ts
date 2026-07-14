// Guard connector — STUB. Reads scanned register images/PDFs from the Supabase
// Storage bucket `guard-registers` for the run date, runs OCR, and maps the
// parsed rows → SourceRow{ source: "PHYSICAL", ... }. OCR provider (Google
// Vision / AWS Textract / Tesseract) is not chosen yet, so ocr() is a TODO.

import type { Connector, CityTaggedRow } from "./types";

// Abstraction seam: swap in the chosen OCR provider here without touching the
// connector interface. Returns raw text lines to be parsed into rows.
async function ocr(_fileBytes: Uint8Array): Promise<string[]> {
  throw new Error("OCR provider not configured.");
}

export const guardConnector: Connector = {
  source: "PHYSICAL",
  label: "Guard Register (OCR)",
  async pull(_runDate: string): Promise<CityTaggedRow[]> {
    // TODO (Phase 6): list guard_uploads for runDate, download each file from
    // the guard-registers bucket, ocr() it, parse lines → CityTaggedRow with
    // source:"PHYSICAL", direction, barcode, status ("done"), date, and the
    // uploading city. Update guard_uploads.status → PARSED + ocr_confidence.
    void ocr;
    throw new Error("Guard OCR connector not implemented yet (provider TBD).");
  },
};
