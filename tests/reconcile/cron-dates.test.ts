import { describe, expect, it } from "vitest";
import {
  currentBusinessDate,
  digestTargetDate,
  followupTargetDate,
  istDate,
  lastClosedBusinessDate,
  reconcileTargetDate,
  recheckTargetDate,
} from "../../lib/reconcile/cron-dates";
import { addDays } from "../../lib/engine/dates";
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
    expect(reconcileTargetDate(atIst("2026-07-26", 16, 30))).toBe("2026-07-25");
    expect(digestTargetDate(atIst("2026-07-26", 16, 45))).toBe("2026-07-25");
  });

  it("both daily jobs always name the same business day", () => {
    for (const day of ["2026-07-23", "2026-08-01", "2026-12-31", "2027-03-01"]) {
      const next = addOneDay(day);
      expect(reconcileTargetDate(atIst(next, 16, 30))).toBe(day);
      expect(digestTargetDate(atIst(next, 16, 45))).toBe(day);
    }
  });

  it("crosses month and year boundaries", () => {
    expect(reconcileTargetDate(atIst("2026-08-01", 16))).toBe("2026-07-31");
    expect(digestTargetDate(atIst("2027-01-01", 16, 45))).toBe("2026-12-31");
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


describe("the re-check pass and the follow-up it feeds", () => {
  // D's digest goes out on D+1; the follow-up on D+3. So D must be re-run on
  // D+3, which is `primary - 2` on that afternoon. A third pipeline pass was
  // the alternative and does not fit the 60s ceiling (measured p50 36s a pass).
  it("re-runs the date whose follow-up is due the same afternoon", () => {
    // 26 Jul: reconciled 27th, emailed 27th, followed up on the 29th.
    expect(reconcileTargetDate(atIst("2026-07-27", 16, 30))).toBe("2026-07-26");
    expect(recheckTargetDate(atIst("2026-07-29", 16, 30))).toBe("2026-07-26");
    expect(followupTargetDate(atIst("2026-07-29", 16, 45))).toBe("2026-07-26");
  });

  it("keeps the re-check and the follow-up on the same date, always", () => {
    // These are one expression for a reason: they briefly were two and
    // disagreed by a day, which would have left the follow-up waiting for a
    // re-run that had already happened on a different date.
    for (const d of ["2026-07-29", "2026-03-01", "2027-01-01", "2028-03-01"]) {
      for (const h of [15, 16, 17, 23]) {
        expect(followupTargetDate(atIst(d, h))).toBe(recheckTargetDate(atIst(d, h)));
      }
    }
  });

  it("is exactly two days behind the day being reconciled", () => {
    for (const d of ["2026-07-29", "2026-01-02", "2026-03-02", "2028-03-01"]) {
      const primary = reconcileTargetDate(atIst(d, 16, 30));
      expect(recheckTargetDate(atIst(d, 16, 30))).toBe(addDays(primary, -2));
    }
  });
});

describe("Hobby cron jitter cannot move the target date", () => {
  // Vercel Hobby does not fire punctually. Every target must be stable across
  // the whole plausible window, or a late fire silently reconciles the wrong
  // day. 16:30 IST scheduled; an hour-plus of slippage still lands after the
  // 15:00 boundary, which is what makes the cadence safe.
  it("resolves the same dates from 16:30 through 23:59 IST", () => {
    const base = "2026-07-29";
    const want = {
      primary: reconcileTargetDate(atIst(base, 16, 30)),
      recheck: recheckTargetDate(atIst(base, 16, 30)),
    };
    for (const [h, m] of [[16, 30], [16, 45], [17, 14], [18, 0], [21, 0], [23, 59]]) {
      expect(reconcileTargetDate(atIst(base, h, m)), `${h}:${m}`).toBe(want.primary);
      expect(digestTargetDate(atIst(base, h, m)), `${h}:${m}`).toBe(want.primary);
      expect(recheckTargetDate(atIst(base, h, m)), `${h}:${m}`).toBe(want.recheck);
    }
  });

  it("would flip if the cadence were ever moved before 15:00 IST", () => {
    // The guard rail: 14:59 belongs to the PREVIOUS business day. Anyone
    // tempted to move the crons earlier has to confront this test.
    expect(reconcileTargetDate(atIst("2026-07-29", 14, 59))).toBe("2026-07-27");
    expect(reconcileTargetDate(atIst("2026-07-29", 15, 1))).toBe("2026-07-28");
  });
});
