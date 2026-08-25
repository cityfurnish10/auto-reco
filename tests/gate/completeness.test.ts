// The trip-close completeness check.
//
// This is the logic that will one day tell a guard a truck is short, so the
// tests are about the ways it could be WRONG rather than the happy path. Two
// failures matter and they are not symmetric:
//
//   a false alarm  teaches guards to dismiss warnings, and then the real one
//                  is dismissed too. This is the expensive one.
//   a missed gap   is the paper register's existing failure — bad, but not a
//                  regression, and caught by reconciliation the same night.
//
// So most of what follows pins the check REFUSING to warn.

import { describe, expect, it } from "vitest";
import { assessTrip, type PlannedLine } from "../../lib/gate/completeness";

const line = (o: Partial<PlannedLine> & { barcode: string }): PlannedLine => ({
  direction: "OUT", pickingRef: "GUR/OUT/3957", ...o,
});
const scan = (barcode: string) => ({ barcode });

describe("scope comes from the scans, never from a guard's choice", () => {
  it("pulls in the rest of a picking the guard scanned from", () => {
    // The core behaviour: three of nine scanned means six missing, and the app
    // worked that out without anyone telling it which order was being loaded.
    const planned = Array.from({ length: 9 }, (_, i) => line({ barcode: `B${i}` }));
    const r = assessTrip([scan("B0"), scan("B1"), scan("B2")], planned, "OUT");
    expect(r.expectedTotal).toBe(9);
    expect(r.expectedScanned).toBe(3);
    expect(r.missing.map((m) => m.barcode)).toEqual(["B3", "B4", "B5", "B6", "B7", "B8"]);
    expect(r.pickings).toEqual(["GUR/OUT/3957"]);
  });

  it("says nothing about a picking this trip never touched", () => {
    // The other truck's load. Warning about it would be the single fastest way
    // to make guards ignore this feature.
    const planned = [
      line({ barcode: "MINE-1", pickingRef: "P1" }),
      line({ barcode: "THEIRS-1", pickingRef: "P2" }),
      line({ barcode: "THEIRS-2", pickingRef: "P2" }),
    ];
    const r = assessTrip([scan("MINE-1")], planned, "OUT");
    expect(r.expectedTotal).toBe(1);
    expect(r.missing).toEqual([]);
    expect(r.pickings).toEqual(["P1"]);
  });

  it("handles a trip spanning several pickings", () => {
    const planned = [
      line({ barcode: "A1", pickingRef: "P1" }),
      line({ barcode: "A2", pickingRef: "P1" }),
      line({ barcode: "B1", pickingRef: "P2" }),
      line({ barcode: "B2", pickingRef: "P2" }),
      line({ barcode: "C1", pickingRef: "P3" }),
    ];
    const r = assessTrip([scan("A1"), scan("B1")], planned, "OUT");
    expect(r.pickings).toEqual(["P1", "P2"]);
    expect(r.expectedTotal).toBe(4);
    expect(r.missing.map((m) => m.barcode)).toEqual(["A2", "B2"]);
  });

  it("reports nothing at all when nothing was scanned", () => {
    // An empty trip touched no picking, so it is short of nothing. The
    // alternative — reporting the whole day as missing — is the worst possible
    // first impression of this feature.
    const planned = [line({ barcode: "A" }), line({ barcode: "B" })];
    const r = assessTrip([], planned, "OUT");
    expect(r.expectedTotal).toBe(0);
    expect(r.missing).toEqual([]);
  });
});

describe("things that must NOT produce a false alarm", () => {
  it("an inward trip is not short because outward work was also planned", () => {
    const planned = [
      line({ barcode: "IN-1", direction: "IN", pickingRef: "PIN" }),
      line({ barcode: "IN-2", direction: "IN", pickingRef: "PIN" }),
      line({ barcode: "OUT-1", direction: "OUT", pickingRef: "POUT" }),
    ];
    const r = assessTrip([scan("IN-1"), scan("IN-2")], planned, "IN");
    expect(r.missing).toEqual([]);
    expect(r.unplannedCount).toBe(0);
  });

  it("a confusable character does not make a scanned item look missing", () => {
    // The fold: FUMY6B… and FUMYGB… are one physical label. Reporting an item
    // as missing when the guard is holding it would destroy trust immediately,
    // and this exact confusion accounts for 57% of items displaying a barcode
    // that exists in no system.
    const planned = [line({ barcode: "FUMYGB23030062", barcodeCanon: "FUMY6B23030062" })];
    const r = assessTrip([scan("FUMY6B23030062")], planned, "OUT");
    expect(r.missing).toEqual([]);
    expect(r.expectedScanned).toBe(1);
  });

  it("a manual entry counts as having seen the item", () => {
    // A sticker that will not scan is still a unit a human looked at. The
    // record is weaker; the item is not more missing.
    const planned = [line({ barcode: "A" }), line({ barcode: "B" })];
    const r = assessTrip([scan("A"), { serialNo: "B" }], planned, "OUT");
    expect(r.missing).toEqual([]);
  });

  it("an empty expected list warns about nothing", () => {
    // Metabase down, or a day genuinely without plans. Either way there is
    // nothing to be short OF, and treating an absent list as an empty one would
    // make every scan an exception.
    const r = assessTrip([scan("A"), scan("B")], [], "OUT");
    expect(r.missing).toEqual([]);
    expect(r.expectedTotal).toBe(0);
    expect(r.unplannedCount).toBe(2);
  });

  it("a planned line with no picking reference cannot be blamed on this trip", () => {
    // It cannot pull siblings in and it cannot be reported missing unless this
    // trip actually scanned it — there is no evidence connecting it here.
    const planned = [
      line({ barcode: "LOOSE", pickingRef: null }),
      line({ barcode: "MINE", pickingRef: "P1" }),
    ];
    const r = assessTrip([scan("MINE")], planned, "OUT");
    expect(r.missing).toEqual([]);
    expect(r.expectedTotal).toBe(1);
  });
});

describe("scans with no plan behind them", () => {
  it("counts them without letting them invent scope", () => {
    // The measurement that decides whether this can ever go live. An item
    // loaded with no picking at all would warn against a perfect list, so how
    // often it happens is an operational fact to gather, not a bug to fix.
    const planned = [line({ barcode: "A" }), line({ barcode: "B" })];
    const r = assessTrip([scan("A"), scan("SURPRISE")], planned, "OUT");
    expect(r.unplannedCount).toBe(1);
    expect(r.expectedTotal).toBe(2);
    expect(r.missing.map((m) => m.barcode)).toEqual(["B"]);
  });
});

describe("what the guard is shown", () => {
  it("carries the detail needed to go and look for it", () => {
    // A bare serial sends a guard to a supervisor. The order and the customer
    // send them to a pallet.
    const planned = [
      line({ barcode: "A" }),
      line({ barcode: "B", product: "Ergonomic Chair", soNumber: "ON-RET-GUR-76196",
             customer: "K S Gudi", deliveryAddress: "12 MG Road" }),
    ];
    const r = assessTrip([scan("A")], planned, "OUT");
    expect(r.missing[0]).toMatchObject({
      barcode: "B", product: "Ergonomic Chair", soNumber: "ON-RET-GUR-76196",
      customer: "K S Gudi", deliveryAddress: "12 MG Road",
    });
  });

  it("does not double-count an item scanned twice", () => {
    const planned = [line({ barcode: "A" }), line({ barcode: "B" })];
    const r = assessTrip([scan("A"), scan("A")], planned, "OUT");
    expect(r.expectedScanned).toBe(1);
    expect(r.missing.map((m) => m.barcode)).toEqual(["B"]);
  });
});
