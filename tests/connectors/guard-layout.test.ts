import { describe, expect, it } from "vitest";
import {
  barcodeFromProductTail,
  guardRowsFromLayout,
  type DiAnalyzeResult,
} from "../../lib/connectors/ocr/document-intelligence";

// ── a register page, as Azure Document Intelligence returns it ──────────────
//
// Real shape, from the live 31 Jul books: one table per page, ~30 columns, the
// barcode written across a band of one-character boxes between Product Name and
// Vehicle No. `rows` is a grid of cell strings; "" is an empty cell.
function page(rows: string[][], opts: { title?: string; pageNumber?: number } = {}): DiAnalyzeResult {
  const cells = [];
  for (let r = 0; r < rows.length; r++)
    for (let c = 0; c < rows[r].length; c++)
      cells.push({
        rowIndex: r,
        columnIndex: c,
        content: rows[r][c],
        boundingRegions: [{ pageNumber: opts.pageNumber ?? 1 }],
      });
  return {
    pages: [{ pageNumber: opts.pageNumber ?? 1, lines: [{ content: opts.title ?? "INWARD REGISTER" }] }],
    tables: [{ rowCount: rows.length, columnCount: rows[0].length, cells }],
  };
}

// 17 columns:
//   0 Sr No | 1 Date | 2 SO Number | 3-5 Ticket band | 6 Customer | 7 Qty |
//   8 Product Name | 9-14 barcode band | 15 Vehicle No | 16 Ops Type
const HEADER = [
  "Sr No", "Date", "SO Number", "Ticket ID", "", "", "Customer Name", "Qty",
  "Product Name", "Barcode", "", "", "", "", "", "Vehicle No", "Ops Type",
];
const BAND = 6;
const body = (
  ticket: [string, string, string],
  product: string,
  band: string[],
  ops = "PICKUP"
) => [
  "1", "31/7/26", "ONRETOUR 72670", ...ticket, "Ravi", "1", product,
  ...band, ...Array(BAND - band.length).fill(""), "3256", ops,
];

const only = (r: DiAnalyzeResult) => guardRowsFromLayout(r)[0];
// Five rows: the table has to clear the rowCount < 5 skip in guardRowsFromLayout.
const filler = () => body(["1", "1", "1"], "Alexa Study Table", ["F", "U", "W", "1", "1", "V"]);
const sheet = (row: string[]) => page([HEADER, row, filler(), filler(), filler(), filler()]);

describe("the barcode band is anchored on the printed header", () => {
  it("concatenates the boxes when the guard wrote one character per box", () => {
    const r = only(sheet(body(["1", "1", "9"], "Belle Queen Bed", ["A", "P", "8", "1", "5", "7"])));
    expect(r.cells.barcode).toBe("AP8157");
    expect(r.cells.product).toBe("Belle Queen Bed");
  });

  it("still reads the barcode when Azure merged the boxes into ONE cell", () => {
    // The failure that cost Delhi two thirds of its inward book on 31 Jul: a
    // guard who writes the label through the boxes instead of one per box gets
    // one wide cell back, so the shape-based walk stopped short of it.
    const r = only(sheet(body(["1", "1", "9"], "Refrigerator SDON", ["", "", "APC7VY23041328"])));
    expect(r.cells.barcode).toBe("APC7VY23041328");
  });

  it("keeps the PRODUCT column pointed at the product name", () => {
    // The old rule called the column left of the band "Product". When the band
    // was mis-found that landed inside it, and the row shipped a barcode as its
    // product — measured on Delhi page 7, every row.
    const r = only(sheet(body(["1", "1", "9"], "Belle Bookshelf", ["", "", "", "FUF17126070004"])));
    expect(r.cells.product).toBe("Belle Bookshelf");
    expect(r.cells.barcode).toBe("FUF17126070004");
  });

  it("drops Azure's checkbox annotations rather than reading them as characters", () => {
    const r = only(sheet(body(["1", "1", "9"], "Hugo Queen Bed", ["F", ":selected:", "U", "6", "0", "1"])));
    expect(r.cells.barcode).toBe("FU601");
  });

  it("strips punctuation and uppercases, so a scanned label is comparable", () => {
    const r = only(sheet(body(["1", "1", "9"], "Alexa Chair", ["fu", "-", "m3", ".", "xj", "19"])));
    expect(r.cells.barcode).toBe("FUM3XJ19");
  });

  it("reads the ticket band, stopping at Customer Name", () => {
    const r = only(sheet(body(["1", "1", "9"], "Belle Queen Bed", ["A", "P", "8", "1", "5", "7"])));
    expect(r.cells.ticket_id).toBe("119");
  });

  it("falls back to the shape-based walk when the Product header did not survive", () => {
    // A header eaten by a fold or a scan edge. Nothing anchors the band, so the
    // old single-character walk still has to work.
    const noProduct = HEADER.map((h) => (h === "Product Name" ? "" : h));
    const rows = [noProduct, body(["1", "1", "9"], "Belle Queen Bed", ["A", "P", "8", "1", "5", "7"])];
    for (let i = 0; i < 4; i++) rows.push(filler());
    const r = only(page(rows));
    expect(r.cells.barcode).toBe("AP8157");
  });

  it("falls back when the header-anchored band is empty but the walk finds boxes", () => {
    // Azure sometimes files a page's body into columns that do not line up with
    // its own header row. Anchoring would return nothing; the walk still reads
    // the boxes, and a page must never do WORSE than it does today.
    const pad = (row: string[]) => [...row, ...Array(HEADER.length - row.length).fill("")];
    const shifted = [pad(HEADER)];
    // Body characters sit LEFT of the Product header, where anchoring cannot see.
    for (let i = 0; i < 5; i++)
      shifted.push(pad(["1", "31/7/26", "SO-1", "A", "P", "8", "1", "5"]));
    const rows = guardRowsFromLayout(page(shifted));
    expect(rows.some((r) => r.cells.barcode !== "")).toBe(true);
  });

  it("takes the page's direction from its printed title", () => {
    const out = guardRowsFromLayout(
      page([HEADER, filler(), filler(), filler(), filler(), filler()], { title: "WAREHOUSE OUTWARD REGISTER" })
    );
    expect(out[0].direction).toBe("OUT");
  });
});

describe("barcodeFromProductTail — a label that spilled into the product cell", () => {
  it("recovers it when the band came back empty", () => {
    expect(barcodeFromProductTail("-Refrigeratorspar APC7VY25040463", "")).toEqual({
      product: "-Refrigeratorspar",
      barcode: "APC7VY25040463",
    });
  });

  it("recovers it when the band caught only a stray character", () => {
    expect(barcodeFromProductTail("Hugo Study Table ISTDCE2N19030226", "A6")?.barcode).toBe(
      "ISTDCE2N19030226"
    );
  });

  it("NEVER overwrites a band read that is already plausible", () => {
    // Otherwise a product name ending in something label-shaped would replace a
    // barcode the boxes gave us correctly.
    expect(barcodeFromProductTail("Sofa AP815725070331", "APC7VY23041328")).toBeNull();
  });

  it("refuses a size suffix — the shape that trails half the product names", () => {
    for (const p of [
      "Mattress Queen Premium 78X60X6",
      "Mattress King Premium 18X72×6",
      "Premium Foam Mattress Single 78x36X4",
      "T.V-43 Smart",
    ])
      expect(barcodeFromProductTail(p, ""), p).toBeNull();
  });

  it("refuses a name that simply ends in a word", () => {
    expect(barcodeFromProductTail("Alexa Dining Table 4 Seater", "")).toBeNull();
    expect(barcodeFromProductTail("Belle Bookshelf", "")).toBeNull();
  });

  it("refuses a single-token product — that token IS the name", () => {
    expect(barcodeFromProductTail("APC7VY25040463", "")).toBeNull();
  });

  it("leaves the product name behind, minus the label", () => {
    expect(barcodeFromProductTail("Tulip 2 seater sof SOEY0X26070007", "")?.product).toBe(
      "Tulip 2 seater sof"
    );
  });
});
