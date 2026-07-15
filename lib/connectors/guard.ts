// Guard connector — reads reviewer-confirmed rows from guard_uploads
// (status='processed') for the run date and maps them to SourceRow. All the
// heavy lifting (OCR, table reconstruction, human review) happens upstream in
// the upload pipeline (app/api/uploads/guard/*) before a row ever reaches
// 'processed' — this connector just reads the confirmed result, the same
// shape as dt.ts/odoo.ts reading their sources from the cron pipeline.

import { createAdminClient } from "../supabase/admin";
import type { Connector, CityTaggedRow } from "./types";
import type { GuardUpload } from "../db/schema";
import type { City } from "../sample-data";

export const guardConnector: Connector = {
  source: "PHYSICAL",
  label: "Guard Register (OCR)",
  async pull(runDate: string): Promise<CityTaggedRow[]> {
    const db = createAdminClient();
    const { data, error } = await db
      .from("guard_uploads")
      .select("*")
      .eq("business_date", runDate)
      .eq("status", "processed");

    if (error) throw new Error(`Guard connector query failed: ${error.message}`);

    const rows: CityTaggedRow[] = [];
    for (const upload of (data ?? []) as GuardUpload[]) {
      const city = upload.city as City;
      for (const row of upload.parsed_rows ?? []) {
        const barcode = row.cells.barcode?.trim();
        // Both should always be present post-review (the PATCH route
        // requires them), but stay defensive against partially-edited rows.
        if (!barcode || !row.direction) continue;

        rows.push({
          source: "PHYSICAL",
          city,
          direction: row.direction,
          barcode,
          status: "done",
          date: runDate,
          soNumber: row.cells.so_number || undefined,
          ticketId: row.cells.ticket_id || undefined,
          product: row.cells.product || undefined,
        });
      }
    }
    return rows;
  },
};
