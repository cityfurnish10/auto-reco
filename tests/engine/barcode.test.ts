import { describe, expect, it } from "vitest";
import { FOLD, canonicalize, isValidBarcode } from "../../lib/engine/barcode";

// Migration 0014 reproduces canonicalize() in SQL so PostgREST can filter on a
// canonical column. These tests pin the TS side of that contract; the live-data
// half is tests/db/canonical-parity.test.ts.

describe("canonicalize — the shape migration 0014 must reproduce", () => {
  it("folds exactly I->1 O->0 S->5 Z->2 G->6, and nothing else", () => {
    // If this fails you are widening the fold. supabase/migrations/
    // 0014_canonical_barcode.sql hard-codes translate(..., 'IOSZG', '10526')
    // and source_rows.barcode_canonical is a STORED generated column, so a
    // widened table needs the column DROPPED and re-ADDED — replacing the SQL
    // function alone leaves every existing value stale. Read 0014's header
    // before changing this.
    expect(FOLD).toEqual({ I: "1", O: "0", S: "5", Z: "2", G: "6" });
  });

  it("uppercases, strips whitespace, then folds — in that order", () => {
    expect(canonicalize("io sz g")).toBe("10526");
    // Folding after uppercasing is why lowercase input folds at all.
    expect(canonicalize("i")).toBe("1");
  });

  it("reproduces both live failures that motivated 0014", () => {
    // Measured 2026-07-29: the evidence panel found 0 rows for each of these
    // because it matched the canonical string against the raw column.
    expect(canonicalize("FUIOL223020032")).toBe("FU10L223020032");
    expect(canonicalize("FU1OL223020032")).toBe("FU10L223020032");
    expect(canonicalize("AP8IS7260160106")).toBe("AP8157260160106");
    expect(canonicalize("OTP4LT220923")).toBe("0TP4LT220923");
  });

  it("is idempotent — the route canonicalizes already-canonical input", () => {
    for (const raw of ["FUIOL223020032", "AP8IS7260160106", "0T005622111020"]) {
      expect(canonicalize(canonicalize(raw))).toBe(canonicalize(raw));
    }
  });

  it("strips the whitespace JavaScript counts, including NBSP", () => {
    // Postgres [[:space:]] does NOT match U+00A0 under glibc, which is why 0014
    // deletes these separately via translate(). A barcode pasted out of Google
    // Sheets carrying an NBSP must land on the same canonical either side.
    const nbsp = String.fromCharCode(0x00a0);
    const zwnbsp = String.fromCharCode(0xfeff);
    const ideographic = String.fromCharCode(0x3000);
    expect(canonicalize(`FU10L2${nbsp}23020032`)).toBe("FU10L223020032");
    expect(canonicalize(`FU10L2${zwnbsp}23020032`)).toBe("FU10L223020032");
    expect(canonicalize(`FU10L2${ideographic}23020032`)).toBe("FU10L223020032");
    expect(canonicalize("  FU10L223020032\t\n")).toBe("FU10L223020032");
  });

  it("leaves digits and unaffected letters alone", () => {
    expect(canonicalize("ABCDEF123456")).toBe("ABCDEF123456");
  });
});

describe("isValidBarcode", () => {
  it("rejects placeholders and too-short input", () => {
    for (const bad of ["", "-", "--", "n/a", "NA", "abc", "   "]) {
      expect(isValidBarcode(bad), bad).toBe(false);
    }
  });

  it("accepts a real barcode", () => {
    expect(isValidBarcode("FU10L223020032")).toBe(true);
  });
});
