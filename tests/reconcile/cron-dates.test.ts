import { describe, expect, it } from "vitest";
import {
  digestTargetDate,
  istDate,
  reconcileTargetDate,
} from "../../lib/reconcile/cron-dates";

// Helper: a real UTC instant for a given IST wall-clock time.
const atIst = (iso: string, istHour: number, istMin = 0) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, istHour, istMin) - 5.5 * 3600e3);
};

describe("nightly cadence — which business day each job targets", () => {
  it("the worked example: 24 Jul reconciled on the 25th night, emailed the 26th morning", () => {
    // Reconcile cron fires 22:00 IST on 2026-07-25 → closes the 24th.
    expect(reconcileTargetDate(atIst("2026-07-25", 22))).toBe("2026-07-24");
    // Digest cron fires 09:00 IST on 2026-07-26 → reports that same 24th.
    expect(digestTargetDate(atIst("2026-07-26", 9))).toBe("2026-07-24");
  });

  it("rolls forward a day: 25 Jul reconciled on the 26th night, emailed the 27th", () => {
    expect(reconcileTargetDate(atIst("2026-07-26", 22))).toBe("2026-07-25");
    expect(digestTargetDate(atIst("2026-07-27", 9))).toBe("2026-07-25");
  });

  it("the reconcile and the NEXT morning's digest always name the same day", () => {
    for (const day of ["2026-07-23", "2026-08-01", "2026-12-31", "2027-03-01"]) {
      const reconciled = reconcileTargetDate(atIst(day, 22));
      const emailed = digestTargetDate(atIst(addOneDay(day), 9));
      expect(emailed).toBe(reconciled);
    }
  });

  it("uses the IST calendar day, not the server's UTC date", () => {
    // 00:30 IST on 26 Jul is still 19:00 UTC on the 25th — the UTC date would
    // give the wrong (one-day-early) target.
    expect(istDate(atIst("2026-07-26", 0, 30))).toBe("2026-07-26");
    expect(reconcileTargetDate(atIst("2026-07-26", 0, 30))).toBe("2026-07-25");
  });

  it("crosses month and year boundaries", () => {
    expect(reconcileTargetDate(atIst("2026-08-01", 22))).toBe("2026-07-31");
    expect(digestTargetDate(atIst("2027-01-01", 9))).toBe("2026-12-30");
  });
});

function addOneDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
