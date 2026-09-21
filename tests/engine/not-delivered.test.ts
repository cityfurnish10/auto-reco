// A delivery that failed and came home the same day is not a variance.
//
// Owner's rule, 21 Sep 2026, from fridge APZQN422041372 on the 18th: the guard
// scanned it out at 09:48 and back at 20:14, the sheet read "Not Delievered"
// outward and "Received" inward, and the Tracker held one row saying Not Done.
// The tool raised two urgent variances telling ops to post it to Odoo — which
// would have been wrong, because no delivery happened.
//
// STRICT BY CHOICE: the Tracker's own Not Done row is required. Without it the
// unit grades as it always did.

import { describe, it, expect } from "vitest";
import { runReconciliation } from "../../lib/engine/run";
import type { SourceRow } from "../../lib/engine/types";

const D = "2026-09-18";
const BC = "APZQN422041372";

const gate = (direction: "IN" | "OUT", barcode = BC): SourceRow => ({
  source: "PHYSICAL", direction, barcode, status: "done", date: D,
});
const sheet = (direction: "IN" | "OUT", status: string, barcode = BC): SourceRow => ({
  source: "SHEET", direction, barcode, status, date: D,
  soNumber: "ON-RET-GUR-74953", ticketId: "1223452", customer: "BHARANI DHARAN",
});
const dt = (physicalStatus: string, barcode = BC): SourceRow => ({
  source: "DT", direction: "OUT", barcode, status: "done", physicalStatus, date: D,
  soNumber: "ON-RET-GUR-74953", ticketId: "1223452",
});

const run = (rows: SourceRow[]) => runReconciliation(rows, "DELHI", undefined, new Set(), D);

describe("not delivered — out and back the same day", () => {
  it("raises nothing when the gate, the sheet and the tracker all say so", () => {
    const res = run([
      gate("OUT"), gate("IN"),
      // The sheet's own misspelling, as Delhi writes it.
      sheet("OUT", "Not Delievered"), sheet("IN", "Received"),
      dt("Not Done"),
    ]);
    expect(res.variances.filter((v) => v.barcode_display === BC)).toHaveLength(0);
    expect(res.warnings.join(" ")).toContain("went out and came back the same day");
  });

  it("still raises when the tracker says the delivery was done", () => {
    const res = run([
      gate("OUT"), gate("IN"),
      sheet("OUT", "Not Delievered"), sheet("IN", "Received"),
      dt("Done"),
    ]);
    expect(res.variances.filter((v) => v.barcode_display === BC).length).toBeGreaterThan(0);
  });

  it("still raises when the tracker has nothing (the wider rule was not chosen)", () => {
    const res = run([
      gate("OUT"), gate("IN"),
      sheet("OUT", "Not Delievered"), sheet("IN", "Received"),
    ]);
    expect(res.variances.filter((v) => v.barcode_display === BC).length).toBeGreaterThan(0);
  });

  it("leaves an ordinary dispatch alone", () => {
    const res = run([gate("OUT"), sheet("OUT", "Delievered"), dt("Done")]);
    expect(res.warnings.join(" ")).not.toContain("went out and came back the same day");
  });
});
