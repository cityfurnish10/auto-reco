// Every fixture below is a REAL row from the production queue, captured
// 2026-08-01 from the 50 open "Gate Register Only" HIGHs since 28 Jul. The
// thresholds in ocr-noise.ts are pinned to this data — 26 of the 50 were OCR
// artifacts (3 summary lines, 18 stray-character repairs, 5 fragments) and the
// remaining 24 are genuine gate-only rows that must pass through UNTOUCHED.

import { describe, expect, it } from "vitest";
import {
  classNear,
  editWithin,
  foldClass,
  grammarSuspect,
  isSummaryLine,
  wordClass,
} from "../../lib/engine/ocr-noise";
import { isSpareJobType } from "../../lib/engine/util";

// ─── tier A: the register's own summary lines ────────────────────────────────

describe("isSummaryLine — the register's furniture is not a movement", () => {
  it("catches the three production footers, canonical-folded and all", () => {
    // "COUNT 014 ITEMS" through the box-band and the canonical fold:
    expect(isSummaryLine("C0UNT0141TEM5", "e parts")).toBe(true);
    // "61 ITEMS OUT" — the 6 is unmappable and strips; ITEN carries it:
    expect(isSummaryLine("611TEN50UT", "count")).toBe(true);
    // barcode unreadable, but the product column says what the line is:
    expect(isSummaryLine("6516EM516RL", "Total 9")).toBe(true);
  });

  it("catches the raw, unfolded spellings identically", () => {
    expect(isSummaryLine("COUNT014ITEMS", "spare parts")).toBe(true);
    expect(isSummaryLine("61ITEMSOUT", null)).toBe(true);
    expect(isSummaryLine("TOTAL9", "")).toBe(true);
  });

  it("passes every real barcode shape untouched", () => {
    // Production survivors and their products — none may be flagged.
    for (const [b, p] of [
      ["AP41TVY260403971", "Refrigerators Dar"],
      ["FUMYHA23030062", "Nico Balcony chair"],
      ["X0TPULT19071784", ""],
      ["2T250100227", ""],
      ["505BW425021004", "Erica 3 Seater Sofa- Cha"],
      ["FUM018220218141", "Vestaking Bed"],
    ] as const) {
      expect(isSummaryLine(b, p), `${b} / ${p}`).toBe(false);
    }
  });
});

// ─── tier B: stray-character repairs ─────────────────────────────────────────

describe("classNear — one stray character + one confusable edit", () => {
  it("matches all the measured production repair shapes", () => {
    const PAIRS: [string, string][] = [
      ["6AP815719030952", "AP815719030952"], // leading stray
      ["AP8157260701351", "AP815726070135"], // trailing stray
      ["FUM4HA230300627", "FUMYHA23030062"], // substitution + trailing stray
      ["UMY6C23020105", "FUMY6C23020105"], // lost leading char
      ["FUMYHA18100236A", "FUMYHA18100236"], // trailing letter
      ["APC7VY230300471", "APC7VY23030047"],
      ["FUMYW52504006818", "FUMYW525040068"],
      ["RUMY62231000361", "FUMY6223100036"], // R/F confusion + trailing stray
    ];
    for (const [a, b] of PAIRS) expect(classNear(a, b), `${a} → ${b}`).toBe(true);
  });

  it("refuses short fragments — no bulldozing under 10 characters", () => {
    expect(classNear("N42150", "AP815719030952")).toBe(false);
    expect(classNear("08166F", "0816619030952F")).toBe(false);
  });

  it("refuses genuinely different barcodes of the same shape", () => {
    // Same length, same prefix family, but three-plus edits apart.
    expect(classNear("AP815719030952", "AP815726070135")).toBe(false);
    expect(classNear("FUMYHA23030062", "FUMY6223100036")).toBe(false);
  });

  it("treats the confusable classes as equal, and only those", () => {
    expect(foldClass("FUIOL22302OO32")).toBe(foldClass("FU10L223020032"));
    expect(editWithin("ABC", "ABD", 1)).toBe(true);
    expect(editWithin("ABC", "ADE", 1)).toBe(false);
  });
});

// ─── tier C: the plausibility grammar ────────────────────────────────────────

describe("grammarSuspect — measured against 13,674 system-typed barcodes", () => {
  it("flags the five production fragments", () => {
    for (const b of [
      "N42150", // 6 chars
      "08166F", // 6 chars
      "F4M410825040067112", // 18 chars
      "0VTEPQU24011006100", // 18 chars
      "APETNY250404702581", // 18 chars
    ]) {
      expect(grammarSuspect(b), b).toBe(true);
    }
  });

  it("passes every production survivor", () => {
    for (const b of [
      "AP41TVY260403971", // 16 — inside the measured envelope
      "MJAP4LT25090042",
      "X0TPULT19071784",
      "2T250100227", // 11 chars, digit-heavy — real short label
      "FUMY6Y21020406P",
      "QTU66BF23070023F",
    ]) {
      expect(grammarSuspect(b), b).toBe(false);
    }
  });
});

// ─── spare hardening ─────────────────────────────────────────────────────────

describe("isSpareJobType — survives the OCR word-class", () => {
  it("still matches the plain spellings", () => {
    expect(isSpareJobType("Spare")).toBe(true);
    expect(isSpareJobType("Spare parts")).toBe(true);
    expect(isSpareJobType("Consumbles")).toBe(true);
  });

  it("matches the digit-confused spellings a register OCR produces", () => {
    expect(isSpareJobType("5PARE")).toBe(true);
    expect(isSpareJobType("5pare part5")).toBe(true);
    expect(isSpareJobType("C0NSUM")).toBe(true);
  });

  it("does not widen beyond the spare family", () => {
    expect(isSpareJobType("PICKUP")).toBe(false);
    expect(isSpareJobType("REPLACE")).toBe(false);
    expect(isSpareJobType(null)).toBe(false);
  });
});

// ─── wordClass itself ────────────────────────────────────────────────────────

describe("wordClass", () => {
  it("inverts the canonical fold for word detection", () => {
    expect(wordClass("C0UNT0141TEM5")).toContain("COUNT");
    expect(wordClass("C0UNT0141TEM5")).toContain("ITEM");
    expect(wordClass("T0TAL9")).toContain("TOTAL");
  });
});

// ─── engine integration: the three hooks end to end ──────────────────────────

import { runReconciliation } from "../../lib/engine/run";
import { VARIANCE } from "../../lib/engine/variance-names";
import type { SourceRow } from "../../lib/engine/types";

const RUN = "2026-07-30";
const row = (p: Partial<SourceRow> & Pick<SourceRow, "source" | "direction" | "barcode">): SourceRow =>
  ({ date: RUN, status: "done", ...p } as SourceRow);

// A fully-reconciled anchor so run-date derivation has a majority.
const anchorRows = (): SourceRow[] => [
  row({ source: "PHYSICAL", direction: "OUT", barcode: "ANCHOR-OK-1" }),
  row({ source: "SHEET", direction: "OUT", barcode: "ANCHOR-OK-1" }),
  row({ source: "DT", direction: "OUT", barcode: "ANCHOR-OK-1" }),
  row({ source: "ODOO", direction: "OUT", barcode: "ANCHOR-OK-1", createdOn: RUN }),
];

describe("engine hooks — OCR noise never reaches the ladder", () => {
  it("hook A: a summary line raises nothing and leaves a warning", () => {
    const res = runReconciliation(
      [...anchorRows(), row({ source: "PHYSICAL", direction: "OUT", barcode: "COUNT014ITEMS", product: "e parts" })],
      "DELHI",
      undefined,
      new Set(),
      RUN
    );
    expect(res.variances.filter((v) => v.variance_name === VARIANCE.GATE_ONLY)).toHaveLength(0);
    expect(res.warnings.some((w) => w.includes("guard summary line skipped"))).toBe(true);
    // And it is not smuggled into the counts either.
    expect(res.summary.consumable_count).toBe(0);
    expect(res.summary.pp_box_count).toBe(0);
  });

  it("hook B: a stray-character read folds into the typed item — one INFO, no HIGH", () => {
    const res = runReconciliation(
      [
        ...anchorRows(),
        // The real unit, seen by the typed sources…
        row({ source: "SHEET", direction: "OUT", barcode: "AP815719030952" }),
        row({ source: "DT", direction: "OUT", barcode: "AP815719030952" }),
        row({ source: "ODOO", direction: "OUT", barcode: "AP815719030952", createdOn: RUN }),
        // …and the guard's read of the same label with a leading stray.
        row({ source: "PHYSICAL", direction: "OUT", barcode: "6AP815719030952" }),
      ],
      "DELHI",
      undefined,
      new Set(),
      RUN
    );
    // Neither a false "gate only" for the stray spelling nor a false
    // "missing from gate register" for the real one.
    expect(res.variances.filter((v) => v.variance_name === VARIANCE.GATE_ONLY)).toHaveLength(0);
    expect(res.variances.filter((v) => v.variance_name === VARIANCE.OPS_ODOO_NO_GATE)).toHaveLength(0);
    expect(res.warnings.some((w) => w.includes("OCR merge"))).toBe(true);
    // Worst case for the merged unit is the tier-3 read-error note.
    for (const v of res.variances.filter((x) => String(x.barcode).includes("815719030952"))) {
      expect(v.variance_name).toBe(VARIANCE.FIELD_MISMATCH);
    }
  });

  it("hook C: a grammar-implausible orphan is parked, not raised", () => {
    const res = runReconciliation(
      [...anchorRows(), row({ source: "PHYSICAL", direction: "OUT", barcode: "F4M410825040067112" })],
      "DELHI",
      undefined,
      new Set(),
      RUN
    );
    expect(res.variances.filter((v) => v.variance_name === VARIANCE.GATE_ONLY)).toHaveLength(0);
    expect(res.warnings.some((w) => w.includes("unreadable gate line parked"))).toBe(true);
  });

  it("a REAL gate-only unit still raises GATE_ONLY — the alarm survives", () => {
    const res = runReconciliation(
      [...anchorRows(), row({ source: "PHYSICAL", direction: "OUT", barcode: "FUMYHA23030062", product: "Nico Balcony chair" })],
      "DELHI",
      undefined,
      new Set(),
      RUN
    );
    expect(res.variances.filter((v) => v.variance_name === VARIANCE.GATE_ONLY)).toHaveLength(1);
  });

  it("an ambiguous repair (two candidates) stays unmerged — no guessing", () => {
    const res = runReconciliation(
      [
        ...anchorRows(),
        row({ source: "ODOO", direction: "OUT", barcode: "AP815719030952", createdOn: RUN }),
        row({ source: "ODOO", direction: "OUT", barcode: "AP815719030956", createdOn: RUN }),
        row({ source: "PHYSICAL", direction: "OUT", barcode: "6AP815719030953" }),
      ],
      "DELHI",
      undefined,
      new Set(),
      RUN
    );
    // Both targets are class-near the orphan → tie → no merge, GATE_ONLY stands
    // (a reviewable false HIGH beats a silent wrong merge).
    expect(res.warnings.some((w) => w.includes("OCR merge") && w.includes("81571903095"))).toBe(false);
  });
});
