// Azure Document Intelligence — "prebuilt-layout" model (async submit + poll).
// Unlike the v3.2 Read API (plain OCR lines), Layout returns real TABLE structure
// — rows, columns, cells — which is what the handwritten guard register needs.
// We turn each register table into guard rows with NO human review.
//
// Reuses AZURE_VISION_ENDPOINT + AZURE_VISION_API_KEY (the same multi-service
// resource exposes Document Intelligence). Confirmed working against real Pune
// registers: correct SO / Product / Ops columns, and the barcode — which the
// form splits into one box per character — is rebuilt by concatenating the
// single-character "barcode band" columns between Product and Vehicle No.

import type { Direction } from "../../engine/types";
import type { ParsedGuardRow } from "../../db/schema";

const API_VERSION = "2024-11-30";
const POLL_MS = 2000;
const TIMEOUT_MS = 55_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function azureDocIntelConfigured(): boolean {
  return !!process.env.AZURE_VISION_ENDPOINT && !!process.env.AZURE_VISION_API_KEY;
}

function baseUrl(): string {
  const url = process.env.AZURE_VISION_ENDPOINT;
  if (!url) throw new Error("AZURE_VISION_ENDPOINT not set.");
  return url.replace(/\/+$/, "");
}
function apiKey(): string {
  const key = process.env.AZURE_VISION_API_KEY;
  if (!key) throw new Error("AZURE_VISION_API_KEY not set.");
  return key;
}

interface DiCell {
  rowIndex: number;
  columnIndex: number;
  content?: string;
  boundingRegions?: { pageNumber: number }[];
}
interface DiTable {
  rowCount: number;
  columnCount: number;
  cells: DiCell[];
}
interface DiPage {
  pageNumber: number;
  lines?: { content: string }[];
}
export interface DiAnalyzeResult {
  pages: DiPage[];
  tables: DiTable[];
}

// Submit the PDF to prebuilt-layout, poll the operation URL to completion.
export async function analyzeLayout(pdfBytes: Uint8Array): Promise<DiAnalyzeResult> {
  const submit = await fetch(
    `${baseUrl()}/documentintelligence/documentModels/prebuilt-layout:analyze?api-version=${API_VERSION}`,
    {
      method: "POST",
      headers: { "Ocp-Apim-Subscription-Key": apiKey(), "Content-Type": "application/pdf" },
      body: Buffer.from(pdfBytes),
    }
  );
  if (submit.status !== 202) {
    throw new Error(`DI layout submit failed: HTTP ${submit.status} ${await submit.text()}`);
  }
  const operationUrl = submit.headers.get("operation-location");
  if (!operationUrl) throw new Error("DI submit returned no operation-location header.");

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const res = await fetch(operationUrl, { headers: { "Ocp-Apim-Subscription-Key": apiKey() } });
    if (!res.ok) throw new Error(`DI poll failed: HTTP ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { status: string; analyzeResult?: DiAnalyzeResult };
    if (json.status === "succeeded") {
      return {
        pages: json.analyzeResult?.pages ?? [],
        tables: json.analyzeResult?.tables ?? [],
      };
    }
    if (json.status === "failed") throw new Error("DI layout analysis failed.");
  }
  throw new Error("DI layout analysis timed out.");
}

const clean = (s: string | undefined) => (s || "").replace(/\s+/g, " ").trim();

// Page direction from the printed "…OUTWARD/INWARD REGISTER" title on each page.
function directionByPage(result: DiAnalyzeResult): Record<number, Direction | null> {
  const map: Record<number, Direction | null> = {};
  for (const p of result.pages) {
    const txt = (p.lines || []).map((l) => l.content).join(" ");
    map[p.pageNumber] = /OUTWARD/i.test(txt) ? "OUT" : /INWARD/i.test(txt) ? "IN" : null;
  }
  return map;
}

// Reconstruct guard rows from one table.
function rowsFromTable(t: DiTable, dir: Direction | null): ParsedGuardRow[] {
  const at = new Map<string, string>();
  let page: number | null = null;
  for (const c of t.cells) {
    at.set(`${c.rowIndex},${c.columnIndex}`, clean(c.content));
    if (page === null && c.boundingRegions?.[0]) page = c.boundingRegions[0].pageNumber;
  }
  const cell = (r: number, c: number | null) => (c == null || c < 0 ? "" : at.get(`${r},${c}`) || "");

  // Locate columns by header keyword (scan the first 3 rows — the header can
  // be noisy on some scans).
  const colOf = (re: RegExp): number | null => {
    for (let r = 0; r < Math.min(3, t.rowCount); r++)
      for (let c = 0; c < t.columnCount; c++) if (re.test(cell(r, c))) return c;
    return null;
  };
  const vehicleCol = colOf(/vehicle/i);
  const opsCol = colOf(/ops|operation|opa\s*type|due\s*type/i);
  const soCol = colOf(/so\s*(number|no)/i);
  const dateCol = colOf(/date/i);
  const ticketCol = colOf(/ticket|tickat/i);

  // Header row = the row with the most header keywords (usually row 0).
  let headerRow = 0;
  let bestHits = -1;
  for (let r = 0; r < Math.min(3, t.rowCount); r++) {
    let hits = 0;
    for (let c = 0; c < t.columnCount; c++)
      if (/so|ticket|customer|product|barcode|vehicle|ops|date|sr\s*no|qty/i.test(cell(r, c))) hits++;
    if (hits > bestHits) { bestHits = hits; headerRow = r; }
  }
  const bodyStart = headerRow + 1;

  // Barcode band: the form splits the barcode into one box per character, so
  // those columns are ~all single-char. Walk left from the Vehicle-No column
  // collecting mostly-single-char columns; the first "wide" column is Product.
  const rightBound = vehicleCol ?? t.columnCount;
  const narrow: number[] = [];
  for (let c = 0; c < t.columnCount; c++) {
    let single = 0, filled = 0;
    for (let r = bodyStart; r < t.rowCount; r++) {
      const v = cell(r, c);
      if (v) { filled++; if (v.replace(/[^A-Za-z0-9]/g, "").length === 1) single++; }
    }
    narrow[c] = filled ? single / filled : 0;
  }
  const bcCols: number[] = [];
  for (let c = rightBound - 1; c >= 0; c--) {
    if (narrow[c] >= 0.35) bcCols.unshift(c);
    else if (bcCols.length) break;
  }
  const productCol = bcCols.length ? bcCols[0] - 1 : null;

  const rows: ParsedGuardRow[] = [];
  for (let r = bodyStart; r < t.rowCount; r++) {
    const barcode = bcCols
      .map((c) => cell(r, c))
      .filter((v) => !/selected/i.test(v)) // drop DI checkbox annotations (":selected:")
      .join("")
      .replace(/[^A-Za-z0-9]/g, "")
      .toUpperCase();
    rows.push({
      page: page ?? 0,
      rowIndex: r - bodyStart,
      direction: dir,
      cells: {
        date: cell(r, dateCol),
        so_number: cell(r, soCol),
        ticket_id: cell(r, ticketCol),
        product: cell(r, productCol),
        po_number: "",
        barcode,
        operation_type: cell(r, opsCol),
      },
      confidence: null,
    });
  }
  return rows;
}

// Turn a whole layout analysis into guard rows (all register tables, every page).
export function guardRowsFromLayout(result: DiAnalyzeResult): ParsedGuardRow[] {
  const dirByPage = directionByPage(result);
  const rows: ParsedGuardRow[] = [];
  for (const t of result.tables) {
    if (t.rowCount < 5) continue; // skip small summary/stray tables
    const page = t.cells.find((c) => c.boundingRegions)?.boundingRegions?.[0]?.pageNumber ?? 0;
    rows.push(...rowsFromTable(t, dirByPage[page] ?? null));
  }
  return rows;
}
