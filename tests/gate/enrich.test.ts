// Enrichment must describe the UNIT, never today's plan.
//
// The gate is only worth having because it is an independent witness. Looking a
// serial up in gate_expected_items — the day's planned pickings — would make it
// agree with Odoo by construction. These tests pin the query to the lot master
// and the separation of derived columns from witnessed ones.

import { describe, expect, it } from "vitest";
import { unitFactsSql } from "../../lib/gate/enrich";

const sql = unitFactsSql(["FUL5ZA24120009", "APC7VY19041490"]);

describe("the enrichment query", () => {
  it("reads the lot master, which is identity", () => {
    expect(sql).toContain("FROM stock_lot sl");
    expect(sql).toContain("product_template");
  });

  it("never touches the day's planned movements", () => {
    // The whole point. gate_expected_items is what the old path used and is
    // exactly what must not appear here.
    expect(sql).not.toContain("gate_expected_items");
    expect(sql.toLowerCase()).not.toContain("expected");
  });

  it("only considers COMPLETED movements for the last-known context", () => {
    // A pending or planned picking would smuggle the plan back in through the
    // history join.
    expect(sql).toContain("sml.state = 'done'");
  });

  it("takes the most recent movement per serial, and survives a unit that never moved", () => {
    expect(sql).toContain("DISTINCT ON (sl.name)");
    expect(sql).toContain("ORDER BY sl.name, sml.date DESC NULLS LAST");
    // LEFT JOIN, so a brand-new unit still returns its product.
    expect(sql).toContain("LEFT JOIN stock_move_line");
  });

  it("asks only about the serials it was given", () => {
    expect(sql).toContain("'FUL5ZA24120009'");
    expect(sql).toContain("'APC7VY19041490'");
  });
});

describe("what the query cannot be made to do", () => {
  // A barcode comes from a QR code a guard pointed a camera at, so its contents
  // are chosen by whoever printed the sticker. Metabase native SQL has no bind
  // parameters, so the builder itself refuses anything that could not be a lot
  // name — safe by construction, not safe-if-called-through-the-wrapper.
  it("drops anything that could not be a serial", () => {
    const dirty = unitFactsSql(["GOOD123456", "'; DROP TABLE gate_scans; --"]);
    expect(dirty).toContain("'GOOD123456'");
    expect(dirty).not.toContain("DROP TABLE");
    expect(dirty).not.toContain("--");
  });

  it("returns an empty string when nothing is askable, so no query is run", () => {
    expect(unitFactsSql(["'; DROP TABLE x; --"])).toBe("");
    expect(unitFactsSql([])).toBe("");
  });

  it("deduplicates, so one truck of identical products is one lookup", () => {
    const s2 = unitFactsSql(["AAA111111", "AAA111111", " AAA111111 "]);
    expect(s2.match(/'AAA111111'/g)).toHaveLength(1);
  });
});
