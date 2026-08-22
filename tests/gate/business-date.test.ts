// The 15:00 boundary is the single easiest thing to get wrong in this build,
// and getting it wrong does not fail loudly — it files a morning's scans
// against yesterday and reconciles them against the wrong day's sources.

import { describe, expect, it } from "vitest";
import { resolveBusinessDate, CLOCK_SKEW_LIMIT_MS } from "../../lib/gate/business-date";
import { geoOk, distanceM } from "../../lib/gate/config";

// IST is UTC+5:30, so 15:00 IST is 09:30 UTC.
const utc = (iso: string) => new Date(iso).toISOString();

describe("resolveBusinessDate", () => {
  it("puts an afternoon scan on the day it happened", () => {
    // 16:00 IST on the 21st = 10:30 UTC. Past the 15:00 cut, so business 21st.
    expect(resolveBusinessDate(utc("2026-08-21T10:30:00Z"))!.businessDate).toBe("2026-08-21");
  });

  it("puts a MORNING scan on the PREVIOUS business day", () => {
    // 10:00 IST on the 21st = 04:30 UTC. Before the cut, so still business 20th.
    // This is the case a calendar date gets wrong for a third of every day.
    expect(resolveBusinessDate(utc("2026-08-21T04:30:00Z"))!.businessDate).toBe("2026-08-20");
  });

  it("moves the day at exactly 15:00 IST and not a minute earlier", () => {
    const just_before = resolveBusinessDate(utc("2026-08-21T09:29:00Z"))!.businessDate;
    const just_after  = resolveBusinessDate(utc("2026-08-21T09:31:00Z"))!.businessDate;
    expect(just_before).toBe("2026-08-20");
    expect(just_after).toBe("2026-08-21");
  });

  it("reports a wrong device clock without rejecting the row", () => {
    const now = new Date("2026-08-21T10:30:00Z");
    const r = resolveBusinessDate(utc("2026-08-22T10:30:00Z"), now);
    // A whole day out — recorded and flagged, never refused: the guard cannot
    // fix a phone setting at the gate and the movement really happened.
    expect(r).not.toBeNull();
    expect(r!.suspectClock).toBe(true);
    expect(r!.skewMs).toBeGreaterThan(CLOCK_SKEW_LIMIT_MS);
  });

  it("does not flag ordinary drift", () => {
    const now = new Date("2026-08-21T10:30:00Z");
    expect(resolveBusinessDate(utc("2026-08-21T10:33:00Z"), now)!.suspectClock).toBe(false);
  });

  it("returns null for junk rather than guessing a date", () => {
    expect(resolveBusinessDate("not a date")).toBeNull();
    expect(resolveBusinessDate("")).toBeNull();
  });
});

describe("geofence", () => {
  it("accepts a fix at the gate", () => {
    expect(geoOk("DELHI", 28.4595, 77.0266)).toBe(true);
  });

  it("rejects a fix kilometres away", () => {
    expect(geoOk("DELHI", 28.7041, 77.1025)).toBe(false);
  });

  it("returns null — NOT false — when there is no fix", () => {
    // A phone indoors against a metal shutter often cannot get one. Treating
    // unknown as outside would flag honest work and teach the guard that the
    // location check is noise.
    expect(geoOk("DELHI", null, null)).toBeNull();
    expect(geoOk("DELHI", 28.4595, undefined)).toBeNull();
  });

  it("measures distance sanely", () => {
    expect(Math.round(distanceM(28.4595, 77.0266, 28.4595, 77.0266))).toBe(0);
    const d = distanceM(28.4595, 77.0266, 28.4695, 77.0266); // ~0.01 deg lat
    expect(d).toBeGreaterThan(1000);
    expect(d).toBeLessThan(1200);
  });
});
