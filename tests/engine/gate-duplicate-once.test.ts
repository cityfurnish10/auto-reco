// A barcode the gate logs twice is ONE movement, and it is flagged.
//
// Decided 14 Sep 2026 when Delhi's reconciliation was switched to the guard
// app: "do not take duplicate entries, only unique entries, flag as duplicate".
// The guard connector deliberately passes a double-logged barcode through twice
// (lib/connectors/guard.ts) and relies on the engine for both halves of that —
// so both halves are pinned here, against the real engine.
import { describe, expect, it } from "vitest";
import { runReconciliation } from "../../lib/engine/run";
import { VARIANCE } from "../../lib/engine/variance-names";
import type { SourceRow } from "../../lib/engine/types";

const RUN = "2026-09-13";
const row = (p: Partial<SourceRow>): SourceRow =>
  ({ source: "PHYSICAL", city: "DELHI", direction: "OUT", barcode: "XXOTP4LT18060116",
     status: "done", date: RUN, ...p } as SourceRow);

describe("a gate scan logged twice", () => {
  const rows = [
    row({}), row({}),                                   // the gate, twice
    row({ source: "DT" }), row({ source: "SHEET" }),
    row({ source: "ODOO", createdOn: RUN }),
  ];
  const res = runReconciliation(rows, "DELHI", { P: true, S: true, D: true, O: true }, new Set(), RUN);

  it("is counted as one movement", () => {
    expect(res.summary.movements).toBe(1);
    expect(res.count_out).toBeDefined();
  });

  it("is flagged as a duplicate scan, and nothing worse", () => {
    const names = res.variances.map((v) => v.variance_name);
    expect(names).toContain(VARIANCE.DUPLICATE);
    expect(res.real_variances).toHaveLength(0);
  });
});
