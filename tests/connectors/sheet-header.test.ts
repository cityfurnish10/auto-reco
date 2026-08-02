import { describe, expect, it } from "vitest";
import { findHeaderRowIndex } from "../../lib/connectors/sheets";
import { deriveReportedByCity } from "../../lib/connectors";
import type { ConnectorResult } from "../../lib/connectors/types";
import type { City } from "../../lib/sample-data";
import type { SourceKind } from "../../lib/engine/types";

const HEADER = [
  "Date", "SO Number", "Ticket ID", "Customer Name", "PO Number", "Vendor Name",
  "SKU", "Barcode", "Vehicle No", "Delivery Associate", "Ops Type",
  "Physical Status", "Odoo Status", "Verified By",
];
const DATA = ["01/06/2026", "ON-RET-PUN-62955", "1156736", "A CUSTOMER", "", "", "# Washing Machine", "AP8IS725070203"];

describe("findHeaderRowIndex", () => {
  it("finds the header under the tab's title row", () => {
    expect(findHeaderRowIndex([["INWARD"], HEADER, DATA])).toBe(1);
  });

  it("finds it under SEVERAL title rows", () => {
    // Pune's Inward tab carried two banner rows on 2026-08-02. The old five-row
    // scan was already thin; a header pushed down by a note or a filter row is
    // the same shape.
    expect(findHeaderRowIndex([["INWARD"], ["INWARD"], [""], ["as of 31/7"], [""], HEADER, DATA])).toBe(5);
  });

  it("accepts the spellings ops use for the date column", () => {
    for (const spelling of ["Date", "DATE", " date ", "Movement Date", "Entry Date"])
      expect(findHeaderRowIndex([[spelling, "Barcode"]]), spelling).toBe(0);
  });

  it("returns NULL when the tab has no header at all", () => {
    // The measured break: the header row was replaced by a second banner, so
    // every row below it became unreachable. Returning 0 here made that
    // indistinguishable from a header that genuinely sits on row 0, and the
    // caller skipped the tab either way without a word.
    expect(findHeaderRowIndex([["INWARD"], ["INWARD"], DATA, DATA])).toBeNull();
  });

  it("returns NULL rather than reading a header far below the top", () => {
    // A "header" 30 rows down is a repeated print header, not the real one.
    const rows: string[][] = Array.from({ length: 30 }, () => DATA);
    rows.push(HEADER);
    expect(findHeaderRowIndex(rows)).toBeNull();
  });

  it("survives a ragged grid — Sheets omits trailing empty cells", () => {
    expect(findHeaderRowIndex([[], ["INWARD"], HEADER])).toBe(2);
  });
});

const result = (source: SourceKind, cities: City[], ok = true): ConnectorResult => ({
  source,
  label: source,
  ok,
  rows: cities.map((city) => ({ city }) as never),
  rowsPulled: cities.length,
  warnings: [],
  startedAt: "", finishedAt: "", durationMs: 0,
});

describe("deriveReportedByCity", () => {
  const all: ConnectorResult[] = [
    result("PHYSICAL", ["DELHI", "PUNE"]),
    result("SHEET", ["DELHI", "PUNE"]),
    result("DT", ["DELHI", "PUNE"]),
    result("ODOO", ["DELHI", "PUNE"]),
  ];

  it("reports a source that returned rows for the city", () => {
    const rep = deriveReportedByCity(all, new Map());
    expect(rep.DELHI).toEqual({ P: true, S: true, D: true, O: true });
  });

  it("does not report a source that failed outright", () => {
    const rep = deriveReportedByCity(
      [result("PHYSICAL", ["DELHI"]), result("SHEET", [], false)],
      new Map()
    );
    expect(rep.DELHI.S).toBe(false);
  });

  it("does not report a source that lost part of the city", () => {
    // Pune's Inward tab, 2026-08-02: the Outward tab still answered, so without
    // this the sheet read as fully reported with a whole direction missing.
    const rep = deriveReportedByCity(all, new Map([["PUNE" as City, new Set<SourceKind>(["SHEET"])]]));
    expect(rep.PUNE.S).toBe(false);
  });

  it("demotes ONLY the city and source that broke", () => {
    const rep = deriveReportedByCity(all, new Map([["PUNE" as City, new Set<SourceKind>(["SHEET"])]]));
    expect(rep.DELHI.S).toBe(true); // other cities keep their sheet
    expect(rep.PUNE).toEqual({ P: true, S: false, D: true, O: true }); // other sources keep Pune
  });

  it("leaves a city nobody reported for entirely blank", () => {
    const rep = deriveReportedByCity(all, new Map());
    expect(rep.MUMBAI).toEqual({ P: false, S: false, D: false, O: false });
  });
});
