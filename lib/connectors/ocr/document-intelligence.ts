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
import { grammarSuspect } from "../../engine/ocr-noise";

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

/**
 * A barcode that spilled into the Product Name cell.
 *
 * The header-anchored band below fixes the case where Azure merged the barcode
 * boxes into one cell INSIDE the band. This is the other half: a guard whose
 * writing starts left of the first box, so Azure files the whole run under
 * Product instead — "‑Refrigeratorspar APC7VY25040463", "LAthema Seatersofa
 * KU9E2523100027". The band then reads empty or a stray character or two.
 *
 * Only ever consulted when the band's own read is IMPLAUSIBLE by the same
 * grammar the engine uses to bin gate-only junk (10–17 chars, alphanumeric,
 * ≥4 digits, measured over 13,674 system-typed labels), and only accepted when
 * the trailing token IS plausible by it. So a real band read is never
 * overwritten, and a product name is never mistaken for a label: the sizes that
 * trail furniture names — "78X60X6", "TV-43", "18X72X6" — are all too short to
 * pass, and a name ending in a word fails on the digit count.
 */
export function barcodeFromProductTail(
  product: string,
  bandBarcode: string
): { product: string; barcode: string } | null {
  if (!grammarSuspect(bandBarcode)) return null; // the band already has a real one
  const parts = product.trim().split(/\s+/);
  if (parts.length < 2) return null; // a bare token IS the product name
  const tail = parts[parts.length - 1].replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (grammarSuspect(tail)) return null;
  return { product: parts.slice(0, -1).join(" "), barcode: tail };
}

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
  const productHdrCol = colOf(/product/i);
  const customerCol = colOf(/customer/i);

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

  // How single-character each column's body is. Still needed for the ticket
  // band and for the fallback below.
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
  const filledIn = (cols: number[]) => {
    let n = 0;
    for (let r = bodyStart; r < t.rowCount; r++)
      if (cols.some((c) => cell(r, c) && !/selected/i.test(cell(r, c)))) n++;
    return n;
  };

  // THE BARCODE BAND, ANCHORED ON THE PRINTED HEADERS.
  //
  // The form splits the barcode into one box per character, and this used to
  // find those boxes by their SHAPE: walk left from Vehicle No collecting
  // columns whose body cells are ≥35% single-character, and call the first wide
  // column Product. That reads the guard's handwriting rather than the form.
  // When a guard writes the barcode as one continuous run instead of box by
  // box, Azure returns it as ONE wide cell — the walk stops there, so the band
  // starts to the right of the real barcode and "Product" lands INSIDE it.
  //
  // Both failures are visible in the 31 Jul books: Delhi page 7 shipped
  // barcode "" with product "APC7VY23041328", and every Bangalore page from 2
  // on shipped a band of one column holding nothing. Across the four registers
  // that day, 738 written lines yielded 225 usable barcodes.
  //
  // The printed header does not move with the handwriting. Product Name and
  // Vehicle No bracket the barcode boxes on all five cities' forms, so the band
  // is simply every column between them — one cell or sixteen, box-by-box or
  // written through, it concatenates the same. Same 738 lines: 483 usable.
  //
  // The old walk stays as the fallback for a page whose Product header did not
  // survive the scan (summary pages, a header eaten by a fold), and for the
  // case where the header-anchored band comes back empty but the shape-based
  // one finds something — so no page can do worse than it does today.
  const narrowWalk = (): number[] => {
    const cols: number[] = [];
    for (let c = rightBound - 1; c >= 0; c--) {
      if (narrow[c] >= 0.35) cols.unshift(c);
      else if (cols.length) break;
    }
    return cols;
  };

  const bandEnd =
    vehicleCol != null && (productHdrCol == null || vehicleCol > productHdrCol)
      ? vehicleCol
      : t.columnCount;
  let bcCols: number[] = [];
  let productCol: number | null = null;
  if (productHdrCol != null && bandEnd - productHdrCol > 1) {
    productCol = productHdrCol;
    for (let c = productHdrCol + 1; c < bandEnd; c++) bcCols.push(c);
  }
  if (bcCols.length === 0 || filledIn(bcCols) === 0) {
    const walked = narrowWalk();
    if (walked.length > 0 && filledIn(walked) > filledIn(bcCols)) {
      bcCols = walked;
      productCol = productHdrCol ?? walked[0] - 1;
    }
  }

  // Ticket-ID band: the ticket (5–7 digits) is written one digit per box, just
  // like the barcode. Walk RIGHT from the Ticket-ID header column collecting the
  // contiguous single-char columns, stopping at the first wide column (Customer
  // Name) and never reaching the barcode band. Empty band → fall back to the
  // single header cell (no regression).
  const tkCols: number[] = [];
  if (ticketCol != null) {
    // Customer Name closes the digit boxes on every form. Preferred over the
    // barcode band's left edge, which the header anchoring above moved left.
    const tkRightBound =
      customerCol != null && customerCol > ticketCol
        ? customerCol
        : bcCols.length
          ? bcCols[0]
          : productCol ?? t.columnCount;
    for (let c = ticketCol; c < tkRightBound && tkCols.length < 8; c++) {
      if (narrow[c] >= 0.35) tkCols.push(c);
      else break;
    }
  }

  const rows: ParsedGuardRow[] = [];
  for (let r = bodyStart; r < t.rowCount; r++) {
    let barcode = bcCols
      .map((c) => cell(r, c))
      .filter((v) => !/selected/i.test(v)) // drop DI checkbox annotations (":selected:")
      .join("")
      .replace(/[^A-Za-z0-9]/g, "")
      .toUpperCase();
    let product = cell(r, productCol);
    const spilled = barcodeFromProductTail(product, barcode);
    if (spilled) ({ product, barcode } = spilled);
    const ticketBand = tkCols
      .map((c) => cell(r, c))
      .filter((v) => !/selected/i.test(v))
      .join("")
      .replace(/[^A-Za-z0-9]/g, "");
    rows.push({
      page: page ?? 0,
      rowIndex: r - bodyStart,
      direction: dir,
      cells: {
        date: cell(r, dateCol),
        so_number: cell(r, soCol),
        ticket_id: ticketBand || cell(r, ticketCol),
        product,
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
