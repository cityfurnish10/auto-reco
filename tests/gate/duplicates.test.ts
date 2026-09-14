import { describe, expect, it } from "vitest";
import { findDuplicates, type DupEntry } from "../../lib/gate/duplicates";

let n = 0;
const e = (p: Partial<DupEntry>): DupEntry => ({
  id: `e${++n}`, tripId: "t1", city: "DELHI", businessDate: "2026-09-13", direction: "OUT",
  barcode: null, serialNo: null, soNumber: null, ticketId: null, itemKind: "unit", quantity: 1,
  notes: null, scannedAt: "2026-09-14T05:00:00.000Z", ...p,
});

describe("scanned barcodes", () => {
  it("same unit, same direction, same day — duplicate even on another truck", () => {
    const a = e({ barcode: "XXOTP4LT18060116", tripId: "t1" });
    const b = e({ barcode: "XXOTP4LT18060116", tripId: "t2", scannedAt: "2026-09-14T06:00:00.000Z" });
    const d = findDuplicates([b, a]);
    expect(d.get(b.id)).toMatchObject({ of: a.id, reason: "same barcode" });
    expect(d.has(a.id)).toBe(false);
  });

  it("matches on the fold, as the engine does (O/0, I/1…)", () => {
    const a = e({ barcode: "FUL5ZA24120009" });
    const b = e({ barcode: "FUL5ZA2412OOO9", scannedAt: "2026-09-14T05:01:00.000Z" });
    expect(findDuplicates([a, b]).has(b.id)).toBe(true);
  });

  it("in, then out, the same day is two movements", () => {
    const a = e({ barcode: "FUL5ZA24120009", direction: "IN" });
    const b = e({ barcode: "FUL5ZA24120009", direction: "OUT", scannedAt: "2026-09-14T09:00:00.000Z" });
    expect(findDuplicates([a, b]).size).toBe(0);
  });
});

describe("typed identifiers", () => {
  it("THE DELHI CASE: one mattress saved three times, 3ms apart", () => {
    const x = [0, 3, 3].map((ms, i) => e({ id: `m${i}`, direction: "IN", itemKind: "customer_return", serialNo: "138193047",
      notes: "Mattress Queen normal..01", scannedAt: new Date(Date.parse("2026-09-13T13:15:20.355Z") + ms).toISOString() }));
    const d = findDuplicates(x);
    expect(d.size).toBe(2);
    expect([...d.values()].every((f) => f.of === "m0")).toBe(true);
  });

  it("identifiers compare without spacing or case", () => {
    const a = e({ serialNo: "PO-TYUI-BJ900", itemKind: "vendor_goods", quantity: 10, direction: "IN" });
    const b = e({ serialNo: "po tyui bj900", itemKind: "vendor_goods", quantity: 10, direction: "IN", scannedAt: "2026-09-14T05:00:01.000Z" });
    expect(findDuplicates([a, b]).get(b.id)?.reason).toBe("same identifier");
  });
});

describe("counted entries with nothing to identify them", () => {
  it("a repeated tap is a duplicate", () => {
    const a = e({ itemKind: "spare_part" });
    const b = e({ itemKind: "spare_part", scannedAt: "2026-09-14T05:00:30.000Z" });
    expect(findDuplicates([a, b]).get(b.id)?.reason).toBe("repeated save");
  });

  it("two spare parts saved minutes apart are two spare parts", () => {
    const a = e({ itemKind: "spare_part" });
    const b = e({ itemKind: "spare_part", scannedAt: "2026-09-14T05:10:00.000Z" });
    expect(findDuplicates([a, b]).size).toBe(0);
  });

  it("different quantity, note, kind or trip is a different entry", () => {
    const base = { itemKind: "pp_box", quantity: 4, scannedAt: "2026-09-14T05:00:00.000Z" };
    const a = e(base);
    const rest = [e({ ...base, quantity: 2 }), e({ ...base, notes: "blue" }), e({ ...base, itemKind: "consumable" }), e({ ...base, tripId: "t9" })];
    expect(findDuplicates([a, ...rest]).size).toBe(0);
  });
});
