// The guard register's job type is OCR'd handwriting and must not outrank the
// typed ops sheet. Measured 2026-09-09: PHYSICAL produced 517 distinct job
// types across 2,896 rows (one new "type" every 5.6 rows) against SHEET's 65
// across 18,598 — and won 605 units where the two disagreed.

import { describe, expect, it } from "vitest";
import { buildViews, jobTypeFor } from "../../lib/engine/views";
import type { SourceRow } from "../../lib/engine/types";
import { canonicalize } from "../../lib/engine/barcode";

const row = (over: Partial<SourceRow>): SourceRow => ({
  source: "SHEET",
  direction: "OUT",
  barcode: "FUL5ZA24120009",
  status: "done",
  ...over,
});

// Views are keyed by the CANONICAL fold (Z->2 here), never the raw spelling.
const jobTypeOf = (rows: SourceRow[]) =>
  buildViews(rows, "DELHI", "OUT").get(canonicalize("FUL5ZA24120009"))?.jobType ?? null;

describe("jobTypeFor — the OCR vocabulary gate", () => {
  it("accepts a term a typed source actually produces", () => {
    expect(jobTypeFor("PHYSICAL", "PICK_UP")).toBe("PICK_UP");
    expect(jobTypeFor("PHYSICAL", "pick up")).toBe("PICK_UP"); // normalized first
  });

  it("rejects OCR misreads rather than guessing at them", () => {
    // Real values from the live queue. DICK_CUP is almost certainly PICK_UP —
    // and "almost certainly" is exactly what this must not record.
    for (const junk of ["DICK_CUP", "DIVAUP", "·REPLACEME", "DELIVERY_CHEVAL", "28/11", "1"]) {
      expect(jobTypeFor("PHYSICAL", junk)).toBeNull();
    }
  });

  it("does not gate the typed sources — their rare values are real", () => {
    expect(jobTypeFor("SHEET", "REFURB_MATERIAL")).toBe("REFURB_MATERIAL");
    expect(jobTypeFor("DT", "RELOCATION_PICKUP")).toBe("RELOCATION_PICKUP");
    expect(jobTypeFor("ODOO", "damaged")).toBe("DAMAGED");
  });

  it("passes null through", () => {
    expect(jobTypeFor("PHYSICAL", null)).toBeNull();
    expect(jobTypeFor("SHEET", "   ")).toBeNull();
  });
});

describe("source precedence", () => {
  it("the typed ops sheet beats the OCR'd register when they disagree", () => {
    expect(
      jobTypeOf([
        row({ source: "PHYSICAL", jobType: "DELIVERY_CHEVAL" }),
        row({ source: "SHEET", jobType: "DELIVERY" }),
      ])
    ).toBe("DELIVERY");
  });

  it("DT still outranks the sheet — it is the engine's native vocabulary", () => {
    expect(
      jobTypeOf([
        row({ source: "SHEET", jobType: "DELIVERED" }),
        row({ source: "DT", jobType: "NEW_RENTAL" }),
      ])
    ).toBe("NEW_RENTAL");
  });

  it("Odoo's procurement_status stays a last resort", () => {
    expect(
      jobTypeOf([
        row({ source: "ODOO", jobType: "ok" }),
        row({ source: "SHEET", jobType: "REPAIR" }),
      ])
    ).toBe("REPAIR");
    // ...but still fills when nothing else has one.
    expect(jobTypeOf([row({ source: "ODOO", jobType: "ok" })])).toBe("OK");
  });

  it("a rejected OCR value does not block the sheet from filling the field", () => {
    // The bug this guards: if the junk claimed the rank on its way to being
    // nulled, a later sheet row could never win, and the field would stay empty
    // even though a typed source knew the answer.
    expect(
      jobTypeOf([
        row({ source: "PHYSICAL", jobType: "DICK_CUP" }),
        row({ source: "SHEET", jobType: "PICK_UP" }),
      ])
    ).toBe("PICK_UP");
  });

  it("a gate-only unit with an unreadable job type reports nothing, not junk", () => {
    expect(jobTypeOf([row({ source: "PHYSICAL", jobType: "DIVAUP" })])).toBeNull();
  });

  it("a gate-only unit with a readable job type still reports it", () => {
    expect(jobTypeOf([row({ source: "PHYSICAL", jobType: "REPAIR" })])).toBe("REPAIR");
  });
});
