// Items in transit — an outward unit seen leaving, with its Odoo Out reserved.
// Decided 14 Sep 2026. Every case pins a rule the user set: count the reserved
// Out only when the gate or DT saw the unit go, outward only.
import { describe, expect, it } from "vitest";
import { runReconciliation } from "../../lib/engine/run";
import { VARIANCE } from "../../lib/engine/variance-names";
import { VARIANCE_META } from "../../lib/engine/buckets";
import type { SourceRow } from "../../lib/engine/types";

const RUN = "2026-09-13";
const ALL = { P: true, S: true, D: true, O: true };
const row = (p: Partial<SourceRow>): SourceRow =>
  ({ source: "PHYSICAL", city: "DELHI", direction: "OUT", barcode: "AP8IS726090175", status: "done", date: RUN, ...p } as SourceRow);
const names = (rows: SourceRow[], pending: string[]) =>
  runReconciliation(rows, "DELHI", ALL, new Set(), RUN, new Set(), new Set(pending)).variances.map((v) => v.variance_name);
// Some unrelated sheet + Odoo rows so every source has reported that day.
const background = [row({ source: "SHEET", barcode: "BGUNIT0000001" }), row({ source: "ODOO", barcode: "BGUNIT0000001", createdOn: RUN })];

describe("items in transit", () => {
  it("THE REPORTED CASE: gate + DT saw it leave, Odoo Out reserved → in transit, not a chase item", () => {
    // AP8IS726090175, Delhi, out 14 Sep 10:16 on DL1LAH 3979; Odoo Out to
    // Meenal Atri, status Available.
    const rows = [...background, row({}), row({ source: "DT" })];
    expect(names(rows, [])).toContain(VARIANCE.PICKUP_ODOO_OPEN);
    const after = names(rows, ["AP815726090175"]); // canonical fold
    expect(after).toContain(VARIANCE.ODOO_OUT_PENDING);
    expect(after).not.toContain(VARIANCE.PICKUP_ODOO_OPEN);
    expect(VARIANCE_META[VARIANCE.ODOO_OUT_PENDING].bucket).toBe("INFO");
  });

  it("gate alone is enough corroboration", () => {
    expect(names([...background, row({})], ["AP815726090175"])).toContain(VARIANCE.ODOO_OUT_PENDING);
  });

  it("DT is enough corroboration where there is no gate record — the Mumbai and Pune case", () => {
    // A paper-register city whose register did not report: sheet + DT saw it
    // go, Odoo holds only the reservation. 54 such rows in the replay.
    const rows = [...background, row({ source: "DT" }), row({ source: "SHEET" })];
    const noGate = { P: false, S: true, D: true, O: true };
    const run = (pending: string[]) => runReconciliation(rows, "MUMBAI", noGate, new Set(), RUN, new Set(), new Set(pending))
      .variances.map((v) => v.variance_name);
    expect(run([])).toContain(VARIANCE.FLOOR_DT_NOT_ODOO);
    expect(run(["AP815726090175"])).toContain(VARIANCE.ODOO_OUT_PENDING);
  });

  it("a reservation with only the ops sheet behind it stays a chase item — no gate, no DT", () => {
    const after = names([...background, row({ source: "SHEET" })], ["AP815726090175"]);
    expect(after).not.toContain(VARIANCE.ODOO_OUT_PENDING);
  });

  it("never applies inward", () => {
    const rows = [...background, row({ direction: "IN" }), row({ source: "DT", direction: "IN" })];
    expect(names(rows, ["AP815726090175"])).not.toContain(VARIANCE.ODOO_OUT_PENDING);
  });

  it("a unit with no reservation keeps its real row", () => {
    expect(names([...background, row({})], ["SOMETHINGELSE1"])).toContain(VARIANCE.GATE_ONLY);
  });
});
