import { describe, expect, it } from "vitest";
import {
  currentBusinessDate,
  digestTargetDate,
  istDate,
  lastClosedBusinessDate,
  reconcileTargetDate,
} from "../../lib/reconcile/cron-dates";
import {
  businessDayToUtcWindow,
  businessDaySpanToUtcWindow,
  utcToBusinessDate,
  utcToIstDate,
} from "../../lib/connectors/ist-window";

// Helper: a real UTC instant for a given IST wall-clock time.
const atIst = (iso: string, istHour: number, istMin = 0) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, istHour, istMin) - 5.5 * 3600e3);
};

const addOneDay = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};
const minusOneDay = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
};

describe("business day — 15:00 → 15:00 IST", () => {
  it("the boundary: 14:59 belongs to yesterday, 15:00 opens today", () => {
    expect(currentBusinessDate(atIst("2026-07-26", 14, 59))).toBe("2026-07-25");
    expect(currentBusinessDate(atIst("2026-07-26", 15, 0))).toBe("2026-07-26");
    expect(currentBusinessDate(atIst("2026-07-26", 15, 1))).toBe("2026-07-26");
  });

  it("a morning instant still belongs to the PREVIOUS business day", () => {
    // 10:00 IST on the 26th sits inside 25 Jul's window (25th 15:00 → 26th 15:00).
    expect(currentBusinessDate(atIst("2026-07-26", 10))).toBe("2026-07-25");
    // 00:30 IST likewise — under the old midnight rule this was the 26th.
    expect(currentBusinessDate(atIst("2026-07-26", 0, 30))).toBe("2026-07-25");
    // The calendar mapping is unchanged and still says the 26th.
    expect(istDate(atIst("2026-07-26", 0, 30))).toBe("2026-07-26");
  });

  it("the worked example: 25 Jul is reconciled AND emailed on the 26th afternoon", () => {
    expect(reconcileTargetDate(atIst("2026-07-26", 16, 0))).toBe("2026-07-25");
    expect(digestTargetDate(atIst("2026-07-26", 16, 15))).toBe("2026-07-25");
  });

  it("both daily jobs always name the same business day", () => {
    for (const day of ["2026-07-23", "2026-08-01", "2026-12-31", "2027-03-01"]) {
      const next = addOneDay(day);
      expect(reconcileTargetDate(atIst(next, 16, 0))).toBe(day);
      expect(digestTargetDate(atIst(next, 16, 15))).toBe(day);
    }
  });

  it("crosses month and year boundaries", () => {
    expect(reconcileTargetDate(atIst("2026-08-01", 16))).toBe("2026-07-31");
    expect(digestTargetDate(atIst("2027-01-01", 16, 15))).toBe("2026-12-31");
  });

  it("lastClosedBusinessDate is always exactly one day behind the open one", () => {
    for (const h of [0, 9, 14, 15, 16, 23]) {
      const now = atIst("2026-07-26", h);
      expect(lastClosedBusinessDate(now)).toBe(minusOneDay(currentBusinessDate(now)));
    }
  });
});

describe("business-day UTC windows", () => {
  it("spans D 09:30Z → D+1 09:30Z (15:00 IST to 15:00 IST)", () => {
    const w = businessDayToUtcWindow("2026-07-25");
    expect(w.startUtc).toBe("2026-07-25T09:30:00.000Z");
    expect(w.endUtcExclusive).toBe("2026-07-26T09:30:00.000Z");
  });

  it("the span variant widens by whole business days on each side", () => {
    const w = businessDaySpanToUtcWindow("2026-07-25", 1, 1);
    expect(w.startUtc).toBe("2026-07-24T09:30:00.000Z");
    expect(w.endUtcExclusive).toBe("2026-07-27T09:30:00.000Z");
  });

  it("utcToBusinessDate is the exact inverse of the window", () => {
    const { startUtc, endUtcExclusive } = businessDayToUtcWindow("2026-07-25");
    expect(utcToBusinessDate(startUtc)).toBe("2026-07-25");
    // One ms before the end is still inside the day…
    expect(utcToBusinessDate(new Date(Date.parse(endUtcExclusive) - 1))).toBe("2026-07-25");
    // …and the exclusive end already belongs to the next one.
    expect(utcToBusinessDate(endUtcExclusive)).toBe("2026-07-26");
  });

  it("attribution differs from the calendar date exactly where it should", () => {
    // The case the re-base exists for. An Odoo posting at 20:00 IST on the 25th
    // and one at 09:00 IST on the 26th are the SAME business day (the 25th),
    // even though their calendar dates differ.
    expect(utcToBusinessDate(atIst("2026-07-25", 20))).toBe("2026-07-25");
    expect(utcToBusinessDate(atIst("2026-07-26", 9))).toBe("2026-07-25");
    expect(utcToIstDate(atIst("2026-07-25", 20))).toBe("2026-07-25");
    expect(utcToIstDate(atIst("2026-07-26", 9))).toBe("2026-07-26");
  });

  it("bad input returns undefined rather than a wrong date", () => {
    expect(utcToBusinessDate(null)).toBeUndefined();
    expect(utcToBusinessDate("")).toBeUndefined();
    expect(utcToBusinessDate("not-a-date")).toBeUndefined();
  });
});
