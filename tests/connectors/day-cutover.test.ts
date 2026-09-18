// The 13 September 2026 cutover, and the seam either side of it.
//
// This is the most dangerous change in the system to get wrong, because every
// way of getting it wrong is silent: a day that overlaps its neighbour
// double-counts movements, and a day that stops short of it loses them. Neither
// raises an error anywhere — they just produce a chase list that is quietly the
// wrong shape.

import { describe, it, expect } from "vitest";
import {
  CALENDAR_DAYS_FROM,
  dayToUtcWindow,
  usesCalendarDay,
  utcToDayDate,
  istDayToUtcWindow,
  businessDayToUtcWindow,
} from "../../lib/connectors/ist-window";

/** An IST wall-clock time as the UTC instant it is. */
const ist = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, m) - 5.5 * 60 * 60 * 1000).toISOString();
};

describe("which definition a date uses", () => {
  it("switches on 13 September 2026", () => {
    expect(CALENDAR_DAYS_FROM).toBe("2026-09-13");
    expect(usesCalendarDay("2026-09-12")).toBe(false);
    expect(usesCalendarDay("2026-09-13")).toBe(true);
    expect(usesCalendarDay("2026-09-14")).toBe(true);
  });

  it("is keyed on the date, so re-running an old day reproduces what it meant", () => {
    // Not "from now on": the re-check pass reaches back days and a manager can
    // re-run any date. A flag flipped today would rewrite history instead.
    expect(dayToUtcWindow("2026-08-01")).toEqual(businessDayToUtcWindow("2026-08-01"));
    expect(dayToUtcWindow("2026-09-20")).toEqual(istDayToUtcWindow("2026-09-20"));
  });
});

describe("placing a movement on a day", () => {
  it("before the cutover, the afternoon starts the next day", () => {
    expect(utcToDayDate(ist("2026-09-10", "16:00"))).toBe("2026-09-10");
    expect(utcToDayDate(ist("2026-09-11", "09:30"))).toBe("2026-09-10");
  });

  it("after it, a morning dispatch belongs to its own day", () => {
    // The whole point of the change: Delhi's outward session is 09:30-11:30,
    // which the old rule filed under the PREVIOUS day.
    expect(utcToDayDate(ist("2026-09-14", "09:30"))).toBe("2026-09-14");
    expect(utcToDayDate(ist("2026-09-14", "16:00"))).toBe("2026-09-14");
    expect(utcToDayDate(ist("2026-09-14", "23:59"))).toBe("2026-09-14");
  });

  it("places the first moment of the cutover day on the cutover day", () => {
    expect(utcToDayDate(ist("2026-09-13", "00:01"))).toBe("2026-09-13");
    // …and the last moment before it on the old day it belonged to.
    expect(utcToDayDate(ist("2026-09-12", "23:59"))).toBe("2026-09-12");
  });
});

describe("the seam — no movement in two days, none in none", () => {
  const cutover = istDayToUtcWindow(CALENDAR_DAYS_FROM).startUtc;

  it("truncates the last old-style day at the boundary", () => {
    const last = dayToUtcWindow("2026-09-12");
    // Nominally it would run to 13 Sep 15:00 and swallow the 13th's morning.
    expect(businessDayToUtcWindow("2026-09-12").endUtcExclusive > cutover).toBe(true);
    expect(last.endUtcExclusive).toBe(cutover);
  });

  it("hands over with no gap and no overlap", () => {
    const last = dayToUtcWindow("2026-09-12");
    const first = dayToUtcWindow("2026-09-13");
    expect(first.startUtc).toBe(last.endUtcExclusive);
  });

  it("leaves days well before the seam untouched", () => {
    expect(dayToUtcWindow("2026-09-11")).toEqual(businessDayToUtcWindow("2026-09-11"));
  });

  it("every instant across the seam lands in exactly one day", () => {
    // Walk the boundary hour by hour and assert each instant falls inside the
    // window of the day it is attributed to.
    for (let h = -30; h <= 30; h++) {
      const at = new Date(Date.parse(cutover) + h * 3600_000).toISOString();
      const day = utcToDayDate(at)!;
      const win = dayToUtcWindow(day);
      expect(at >= win.startUtc && at < win.endUtcExclusive, `${at} → ${day}`).toBe(true);
    }
  });
});

describe("Odoo Out — the team's 3pm window", () => {
  // Checked 18 Sep 2026 against Odoo's own Moves History for Delhi (Done ·
  // Movement Type = Out · GUR · Date 15 Sep 15:00 → 16 Sep 15:00): 70 rows.
  it("places a lunchtime posting on the previous day's movements", async () => {
    const { utcToOdooOutDate } = await import("../../lib/connectors/ist-window");
    expect(utcToOdooOutDate(ist("2026-09-16", "12:30"))).toBe("2026-09-15");
    expect(utcToOdooOutDate(ist("2026-09-15", "16:00"))).toBe("2026-09-15");
  });

  it("keeps the 3pm batch together — 30 seconds of grace, no more", async () => {
    const { utcToOdooOutDate } = await import("../../lib/connectors/ist-window");
    const at = (hms: string) => {
      const [h, m, s] = hms.split(":").map(Number);
      return new Date(Date.UTC(2026, 8, 16, h, m, s) - 5.5 * 3600_000).toISOString();
    };
    // The two postings that straddled the edge on the 16th.
    expect(utcToOdooOutDate(at("15:00:13"))).toBe("2026-09-15");
    expect(utcToOdooOutDate(at("15:00:58"))).toBe("2026-09-16");
    expect(utcToOdooOutDate(at("14:59:59"))).toBe("2026-09-15");
  });
});
