// Reconstructs a row/column grid from plain OCR output (Azure's Read API gives
// text lines + bounding boxes only — no table structure, since Document
// Intelligence's table model isn't what's wired up here). This is the standard
// geometric approach for recovering a table from plain-OCR line geometry,
// adapted for a HANDWRITTEN register:
//
//   1. Group lines into rows by Y-proximity, using an ADAPTIVE threshold (a
//      fraction of the page's median line height) rather than a fixed pixel
//      value — necessary because scan resolution/zoom varies per upload.
//   2. Treat the topmost row as the column-header row (title text is more
//      likely printed, so more OCR-reliable than the handwritten body) and
//      derive column X-ranges from ITS cell positions, rather than clustering
//      X-positions across all rows — handwritten entries drift/slant enough
//      that global clustering is unreliable; anchoring to the header isn't.
//   3. Assign every body line to its nearest header-derived column by X-center.
//      Multiple lines landing in the same (row, column) cell — e.g. wrapped
//      text — concatenate in left-to-right reading order.
//
// Every row this produces is reviewed/correctable by a human before it's
// trusted (see review-grid.tsx) — this is a best-effort first pass, not a
// silent source of truth.

import type { OcrLine, OcrPoint } from "./azure-vision";

// The register's real, confirmed columns, left to right (Sr. No, Date, SO
// No, Ticket ID, Customer Name, PO No, Vendor, Product Name, Barcode,
// Vehicle No, Delivery Associate, Operation Type). All 11 are needed here to
// anchor column X-ranges off the header row correctly — reconstructing as if
// the form only had the 7 columns we actually keep (below) would misalign
// every column boundary once the OCR'd header has more cells than that.
export const REGISTER_COLUMNS = [
  "sr_no",
  "date",
  "so_number",
  "ticket_id",
  "customer_name",
  "po_number",
  "vendor",
  "product",
  "barcode",
  "vehicle_no",
  "delivery_associate",
  "operation_type",
] as const;

// The subset actually surfaced to the reviewer, stored in parsed_rows, and
// read by guard.ts — everything else on the register (Sr. No, Customer
// Name, Vendor, Vehicle No, Delivery Associate) is reconstructed for
// column-alignment purposes only and then discarded.
export const GUARD_COLUMNS = [
  "date",
  "so_number",
  "ticket_id",
  "product",
  "po_number",
  "barcode",
  "operation_type",
] as const;

export interface ParsedRowCells {
  rowIndex: number;
  cells: Record<string, string>;
  confidence: number | null;
}

interface LineGeometry {
  line: OcrLine;
  centerX: number;
  centerY: number;
  height: number;
}

function geometry(line: OcrLine): LineGeometry {
  const xs = line.box.map((p: OcrPoint) => p.x);
  const ys = line.box.map((p: OcrPoint) => p.y);
  const centerX = xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const centerY = ys.reduce((a, b) => a + b, 0) / (ys.length || 1);
  const height = Math.max(...ys) - Math.min(...ys);
  return { line, centerX, centerY, height };
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Groups line geometries into rows using an adaptive Y-gap threshold.
function groupIntoRows(geoms: LineGeometry[]): LineGeometry[][] {
  if (geoms.length === 0) return [];
  const sorted = [...geoms].sort((a, b) => a.centerY - b.centerY);
  const medianHeight = median(sorted.map((g) => g.height)) || 20;
  const threshold = medianHeight * 0.55;

  const rows: LineGeometry[][] = [];
  let current: LineGeometry[] = [sorted[0]];
  let runningY = sorted[0].centerY;

  for (let i = 1; i < sorted.length; i++) {
    const g = sorted[i];
    if (Math.abs(g.centerY - runningY) > threshold) {
      rows.push(current);
      current = [g];
      runningY = g.centerY;
    } else {
      current.push(g);
      // Running average keeps the row's reference point stable as it grows.
      runningY = current.reduce((s, x) => s + x.centerY, 0) / current.length;
    }
  }
  rows.push(current);
  return rows;
}

// Derives column X-ranges from the header row's cell centers: boundaries sit
// at the midpoints between adjacent header cells, open-ended at both edges.
function columnBoundsFromHeader(
  headerRow: LineGeometry[],
  columnCount: number
): number[] {
  const centers = [...headerRow].sort((a, b) => a.centerX - b.centerX).map((g) => g.centerX);

  if (centers.length === columnCount) {
    const bounds: number[] = [-Infinity];
    for (let i = 0; i < centers.length - 1; i++) {
      bounds.push((centers[i] + centers[i + 1]) / 2);
    }
    bounds.push(Infinity);
    return bounds;
  }

  // Fallback: header didn't OCR into exactly columnCount cells — fall back to
  // evenly-spaced buckets across the observed X range rather than failing.
  const allX = headerRow.map((g) => g.centerX);
  const minX = allX.length ? Math.min(...allX) : 0;
  const maxX = allX.length ? Math.max(...allX) : 1000;
  const span = maxX - minX || 1000;
  const bounds: number[] = [-Infinity];
  for (let i = 1; i < columnCount; i++) {
    bounds.push(minX + (span * i) / columnCount);
  }
  bounds.push(Infinity);
  return bounds;
}

function columnIndexFor(centerX: number, bounds: number[]): number {
  // bounds has columnCount+1 entries; find the bucket centerX falls into.
  for (let i = 0; i < bounds.length - 1; i++) {
    if (centerX >= bounds[i] && centerX < bounds[i + 1]) return i;
  }
  return bounds.length - 2; // last bucket
}

export function reconstructGrid(
  lines: OcrLine[],
  columns: readonly string[] = GUARD_COLUMNS,
  allColumns: readonly string[] = REGISTER_COLUMNS
): ParsedRowCells[] {
  const geoms = lines.map(geometry);
  const rows = groupIntoRows(geoms);
  if (rows.length <= 1) return []; // no body rows (just a header, or empty page)

  const [headerRow, ...bodyRows] = rows;
  const bounds = columnBoundsFromHeader(headerRow, allColumns.length);

  return bodyRows.map((row, rowIndex) => {
    const byColumn: string[][] = allColumns.map(() => []);
    const confidences: number[] = [];

    for (const g of [...row].sort((a, b) => a.centerX - b.centerX)) {
      const colIdx = columnIndexFor(g.centerX, bounds);
      byColumn[colIdx].push(g.line.text);
      if (typeof g.line.confidence === "number") confidences.push(g.line.confidence);
    }

    const cells: Record<string, string> = {};
    columns.forEach((col) => {
      const fullIdx = allColumns.indexOf(col);
      cells[col] = fullIdx === -1 ? "" : byColumn[fullIdx].join(" ").trim();
    });

    return {
      rowIndex,
      cells,
      confidence: confidences.length
        ? confidences.reduce((a, b) => a + b, 0) / confidences.length
        : null,
    };
  });
}
