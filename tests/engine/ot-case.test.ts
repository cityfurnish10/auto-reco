// Order transfers — raised as OT CASE, never counted as a movement.
//
// Decided 18 Sep 2026. Delhi's 16th: Odoo's own screen showed 84 Out, the tool
// 81; the three were order transfers (Reference# OT-…) that appear at no gate,
// sheet or tracker. Dropped silently they made the two disagree with nothing
// saying why; matched normally they would send someone hunting a unit that
// never moved. So each becomes one OT CASE to map by hand.

import { describe, it, expect } from "vitest";
import { runReconciliation } from "../../lib/engine/run";
import { VARIANCE } from "../../lib/engine/variance-names";
import type { SourceRow } from "../../lib/engine/types";

const D = "2026-09-16";
const odoo = (barcode: string, extra: Partial<SourceRow> = {}): SourceRow => ({
  source: "ODOO", direction: "OUT", barcode, status: "done", date: D,
  createdOn: D, soNumber: "ON-RET-GUR-81269", ...extra,
});
const gate = (barcode: string): SourceRow => ({ source: "PHYSICAL", direction: "OUT", barcode, status: "done", date: D });

describe("OT CASE", () => {
  const rows: SourceRow[] = [
    odoo("OTEPQU23121011", { orderTransferRef: "OT-20260910-ECAE50" }),
    odoo("FUMYSU23010016"),
    gate("FUMYSU23010016"),
  ];
  const res = runReconciliation(rows, "DELHI", undefined, new Set(), D);

  it("raises one OT CASE for the transfer, flagged for manual mapping", () => {
    const ot = res.variances.filter((v) => v.variance_name === VARIANCE.OT_CASE);
    expect(ot).toHaveLength(1);
    expect(ot[0].barcode_display).toBe("OTEPQU23121011");
    expect(ot[0].bucket).toBe("REAL");
    expect(ot[0].note).toContain("OT-20260910-ECAE50");
  });

  it("never raises it as an Odoo-only movement as well", () => {
    const others = res.variances.filter(
      (v) => v.barcode_display === "OTEPQU23121011" && v.variance_name !== VARIANCE.OT_CASE
    );
    expect(others).toEqual([]);
  });

  it("leaves it out of the Odoo count", () => {
    // One real Odoo Out posting on the day; the transfer is not a movement.
    expect(res.count_out.odoo_same_day).toBe(1);
  });

  it("is raised only on the day it posted", () => {
    const other = runReconciliation(
      [odoo("OTEPQU23121011", { orderTransferRef: "OT-1", createdOn: "2026-09-15" }), gate("X1Y2Z3A4B5C6")],
      "DELHI", undefined, new Set(), D
    );
    expect(other.variances.some((v) => v.variance_name === VARIANCE.OT_CASE)).toBe(false);
  });
});
