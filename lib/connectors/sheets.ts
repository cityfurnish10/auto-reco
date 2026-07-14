// Google Sheets connector — reads the 5 ops warehouse sheets and maps rows →
// SourceRow{ source: "SHEET", ... }. Auth is a service account
// (GOOGLE_SERVICE_ACCOUNT_KEY). The per-city spreadsheet IDs + the column
// layout still need to be supplied (SHEETS_CONFIG) before this is fully live,
// so mapRow() is the one remaining piece.

import type { Connector, CityTaggedRow } from "./types";

// SHEETS_CONFIG (env, JSON): { "DELHI": { "spreadsheetId": "...", "range": "Sheet1!A2:H" }, ... }
function readConfig(): Record<string, { spreadsheetId: string; range: string }> | null {
  const raw = process.env.SHEETS_CONFIG;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export const sheetsConnector: Connector = {
  source: "SHEET",
  label: "Google Sheets",
  async pull(_runDate: string): Promise<CityTaggedRow[]> {
    const config = readConfig();
    if (!config || !process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      throw new Error(
        "Sheets not configured (need GOOGLE_SERVICE_ACCOUNT_KEY + SHEETS_CONFIG)."
      );
    }
    // TODO (Phase 7): using `googleapis` (already installed), authorize the
    // service account, spreadsheets.values.get per city range, and map each row
    // to a CityTaggedRow with source:"SHEET", direction, barcode, status:"done",
    // soNumber, ticketId, customer, product, date.
    throw new Error("Sheets connector mapping not implemented yet (needs SHEETS_CONFIG).");
  },
};
