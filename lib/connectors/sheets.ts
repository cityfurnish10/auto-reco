// Google Sheets connector — reads the 5 per-city warehouse "Movement
// Register" spreadsheets via a Google service account (server-to-server, no
// user login) and maps rows → SourceRow{ source: "SHEET", ... }.
//
// Auth: GOOGLE_SERVICE_ACCOUNT_KEY — the service account's JSON key, either
// pasted raw or base64-encoded, as one env var (must be a single line — a
// raw multi-line JSON blob breaks standard .env parsing). The sheet itself
// must be shared with that key's client_email (Viewer access) — service
// accounts have no access of their own, same as adding a collaborator.
//
// Config: SHEETS_CONFIG — JSON env var mapping city → {spreadsheetId, ...}:
//   {"DELHI": {"spreadsheetId": "1Abc..."}, ...}
//
// Real layout (confirmed against the 5 live sheets, 2026-07): each city's
// spreadsheet has separate "Outward" and "Inward" tabs — direction comes
// from which tab a row is on, not from a column value (an "Ops Type"/
// "Operations Type" column exists but holds job-type-like text — Delivery,
// Pick Up, New - Rental, Upgrade — not IN/OUT, and the engine only reads
// jobType from ODOO rows anyway, so it's not mapped here). Tab names are
// overridable per city (outwardSheet/inwardSheet) in case one city's naming
// ever diverges; default to "Outward"/"Inward", which all 5 currently use.
//
// Row 1 in every tab is a single-cell title ("OUTWARD"/"Inward "/etc, casing
// and trailing space vary) — the real header is row 2. Column order is read
// from that header's text (case-insensitive, several alias spellings), not
// fixed positions, so ops staff reordering columns doesn't silently corrupt
// the mapping; the header row itself is *found* (first row containing a
// "date" cell, scanning the first few rows) rather than assumed to be a
// fixed index, so a tab with or without the title row above it both work.
//
// Each pull fetches a tab's full used range, then keeps only the last
// ROW_BUFFER data rows (a rolling buffer, not the whole sheet history) —
// reconciliation only ever needs the single business date it's running for
// (D-1, see app/api/cron/reconcile/route.ts), so 200 rows per tab is
// comfortably more than one day's entries without pulling months of history.

import { google, sheets_v4 } from "googleapis";
import type { Connector, CityTaggedRow } from "./types";
import { normalizeCity } from "./types";
import { readServiceAccountKey } from "./google-service-account";
import { detectDateOrder, resolveSheetDate } from "./sheets-mapping";
import type { Direction } from "../engine/types";

// Sized for backfill pulls, not just the nightly D-1 run: the busiest tab
// (BAN Outward) logs ~150-200 rows/day, so 200 only covered "yesterday" and a
// re-run for an older date silently lost most of that day's rows (measured:
// a D-3 pull of 2026-07-12 found 20 of ~200 BAN rows → false variance flood).
// The API call fetches the whole used range regardless — the buffer is just a
// row-cap, so 1500 (~1 week of the busiest sheet) costs nothing extra.
const ROW_BUFFER = 1500;
const DEFAULT_OUTWARD_SHEET = "Outward";
const DEFAULT_INWARD_SHEET = "Inward";
const HEADER_SCAN_ROWS = 5;

interface SheetConfigEntry {
  spreadsheetId: string;
  outwardSheet?: string;
  inwardSheet?: string;
}

function readSheetsConfig(): Record<string, SheetConfigEntry> | null {
  const raw = process.env.SHEETS_CONFIG;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, SheetConfigEntry>;
    return Object.keys(parsed).length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

let sheetsApiPromise: Promise<sheets_v4.Sheets> | null = null;

function getSheetsApi(): Promise<sheets_v4.Sheets> {
  if (!sheetsApiPromise) {
    const key = readServiceAccountKey();
    if (!key) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY missing or invalid.");
    const auth = new google.auth.GoogleAuth({
      credentials: { client_email: key.client_email, private_key: key.private_key },
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    sheetsApiPromise = Promise.resolve(google.sheets({ version: "v4", auth }));
  }
  return sheetsApiPromise;
}

function str(v: unknown): string | undefined {
  if (v == null || v === "") return undefined;
  return String(v).trim();
}

// The title row above the header ("OUTWARD"/"Inward ") means the header
// isn't always row 0 — find the first of the first few rows that contains a
// "date" cell, rather than assuming a fixed offset.
function findHeaderRowIndex(values: unknown[][]): number {
  for (let i = 0; i < Math.min(values.length, HEADER_SCAN_ROWS); i++) {
    const row = values[i].map((c) => String(c ?? "").trim().toLowerCase());
    if (row.includes("date")) return i;
  }
  return 0;
}

// header text → column index, case-insensitive, first match wins across
// alias spellings (the live sheets use "Barcode" on Inward tabs but
// "Barcodes" on some Outward tabs, for example).
function buildColumnIndex(headerRow: unknown[]) {
  const header = headerRow.map((h) => String(h ?? "").trim().toLowerCase());
  const col = (...names: string[]) => {
    for (const n of names) {
      const idx = header.indexOf(n);
      if (idx !== -1) return idx;
    }
    return -1;
  };
  return {
    date: col("date"),
    barcode: col("barcode", "barcodes", "barcode/id"),
    soNumber: col("so number", "so_number", "so no"),
    // Vendor rows (Inward tab) carry a PO Number and a blank SO — used as the
    // soNumber fallback so vendor items still have a join identifier.
    poNumber: col("po number", "po_number", "po no"),
    ticketId: col("ticket id", "ticket_id"),
    customer: col("customer name", "customer"),
    product: col("sku", "product", "item name", "item code"),
    // "Delivered"/"Received" → done; "Not Delivered" → not_done — drives the
    // engine's failed-delivery rule (OUT logged as not delivered must have a
    // matching IN return entry). Blank defaults to done (presence = done).
    status: col("physical status", "status"),
    // Ops Type text (New - Rental / Pick Up / Repair / Upgrade / …) — engine
    // normalizes; REPAIR/REPLACE/NEW_RENTAL drive suppression rules.
    opsType: col("ops type", "operations type", "ops_type", "operation type"),
  };
}

export const sheetsConnector: Connector = {
  source: "SHEET",
  label: "Google Sheets",
  async pull(runDate: string): Promise<CityTaggedRow[]> {
    const config = readSheetsConfig();
    if (!config) throw new Error("Sheets not configured (set SHEETS_CONFIG).");
    if (!readServiceAccountKey()) {
      throw new Error("Sheets not configured (set GOOGLE_SERVICE_ACCOUNT_KEY).");
    }

    const api = await getSheetsApi();
    const rows: CityTaggedRow[] = [];

    for (const [cityKey, entry] of Object.entries(config)) {
      const city = normalizeCity(cityKey);
      if (!city) continue; // bad SHEETS_CONFIG key — skip, don't fail the other 4 cities

      const tabs: Array<{ name: string; direction: Direction }> = [
        { name: entry.outwardSheet?.trim() || DEFAULT_OUTWARD_SHEET, direction: "OUT" },
        { name: entry.inwardSheet?.trim() || DEFAULT_INWARD_SHEET, direction: "IN" },
      ];

      for (const tab of tabs) {
        let values: unknown[][];
        let displayed: unknown[][]; // same grid, FORMATTED (what ops actually see)
        try {
          const [uRes, fRes] = await Promise.all([
            api.spreadsheets.values.get({
              spreadsheetId: entry.spreadsheetId,
              range: `${tab.name}!A1:Z`, // unbounded rows — API returns only rows with data
              valueRenderOption: "UNFORMATTED_VALUE",
              dateTimeRenderOption: "SERIAL_NUMBER",
            }),
            api.spreadsheets.values.get({
              spreadsheetId: entry.spreadsheetId,
              range: `${tab.name}!A1:Z`,
              valueRenderOption: "FORMATTED_VALUE", // the displayed string, not the serial
            }),
          ]);
          values = uRes.data.values ?? [];
          displayed = fRes.data.values ?? [];
        } catch (err) {
          throw new Error(
            `Sheets pull failed for ${cityKey}/${tab.name}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        if (values.length < 2) continue; // header only, or empty

        const headerIdx = findHeaderRowIndex(values);
        const idx = buildColumnIndex(values[headerIdx]);
        if (idx.date === -1 || idx.barcode === -1) continue; // can't reconcile without these

        // Date resolution reconciles the raw serial (UNFORMATTED) with the
        // displayed string (FORMATTED) — see resolveSheetDate. The sheets are
        // internally inconsistent: DELHI serials are correct but display US
        // M/D/Y; HYD/MUM display the intended India D/M day but their serial is
        // a MM/DD-corrupted value (46363 = Dec-7 for a "12-07" = 12-Jul entry).
        // Trusting either one alone drops a whole city's day or mis-files it.
        // Non-date fields still come from UNFORMATTED (exact barcodes).
        //
        // These sheets also carry thousands of blank template rows after the
        // real data — filter to rows with a date cell BEFORE the buffer, or
        // slice(-ROW_BUFFER) grabs blank filler instead of real entries.
        const dataRows: Array<{ line: unknown[]; serialCell: unknown; displayCell: unknown }> = [];
        for (let i = headerIdx + 1; i < values.length; i++) {
          const serialCell = values[i]?.[idx.date];
          const displayCell = displayed[i]?.[idx.date];
          if ((serialCell == null || serialCell === "") && (displayCell == null || displayCell === "")) continue;
          dataRows.push({ line: values[i], serialCell, displayCell });
        }
        const recentRows = dataRows.slice(-ROW_BUFFER); // last N real data rows only

        // Detect THIS sheet's date field order from its own recent rows (the
        // latest appended rows are the current month, so their day-of-month
        // values 13..31 reveal whether it writes day-first or month-first —
        // e.g. DELHI "7/13" = month-first, HYD "13-07" = day-first). Ambiguous
        // both-≤12 dates (like the 12th) are then read with that order.
        const dateOrder = detectDateOrder(recentRows.map((r) => r.displayCell));

        for (const { line, serialCell, displayCell } of recentRows) {
          const date = resolveSheetDate(serialCell, displayCell, dateOrder, runDate);
          if (date !== runDate) continue; // filter to the run's business date

          const barcode = str(line[idx.barcode]);
          if (!barcode) continue;

          const soNumber = idx.soNumber !== -1 ? str(line[idx.soNumber]) : undefined;
          const poNumber = idx.poNumber !== -1 ? str(line[idx.poNumber]) : undefined;
          rows.push({
            source: "SHEET",
            city,
            direction: tab.direction,
            barcode,
            // Physical Status when present ("Delivered"/"Not Delivered"/…);
            // blank = presence = done (IMPLEMENTATION_PLAN.md §A3).
            status: (idx.status !== -1 ? str(line[idx.status]) : undefined) ?? "done",
            date,
            soNumber: soNumber ?? poNumber, // vendor rows: PO stands in for SO
            ticketId: idx.ticketId !== -1 ? str(line[idx.ticketId]) : undefined,
            customer: idx.customer !== -1 ? str(line[idx.customer]) : undefined,
            product: idx.product !== -1 ? str(line[idx.product]) : undefined,
            jobType: idx.opsType !== -1 ? str(line[idx.opsType]) : undefined,
          });
        }
      }
    }
    return rows;
  },
};
