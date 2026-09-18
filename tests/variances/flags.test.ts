import { describe, it, expect } from "vitest";
import { flagsFor, isVendorJob, FLAG, odooWindowEnd } from "../../lib/variances/flags";


const base = { odooWindowEndMs: null, nowMs: 0, guardOnDuty: null, notDelivered: false };

describe("variance flags", () => {
  it("ODOO PENDING only while Odoo lacks it and the window is open", () => {
    const v = { direction: "OUT", job_type: null, present_o: false };
    expect(flagsFor(v, { ...base, odooWindowEndMs: 100, nowMs: 50 })).toEqual([FLAG.ODOO_PENDING]);
    expect(flagsFor(v, { ...base, odooWindowEndMs: 100, nowMs: 100 })).toEqual([]);
    expect(flagsFor({ ...v, present_o: true }, { ...base, odooWindowEndMs: 100, nowMs: 50 })).toEqual([]);
  });

  it("VENDOR RECEIPT for a PO inward the tracker lacks, not PO Payment", () => {
    expect(flagsFor({ direction: "IN", job_type: "PO_INWARD", present_d: false }, base)).toEqual([FLAG.VENDOR_RECEIPT]);
    expect(flagsFor({ direction: "IN", job_type: "PO_INWARD", present_d: true }, base)).toEqual([]);
    expect(flagsFor({ direction: "OUT", job_type: "PO_INWARD", present_d: false }, base)).toEqual([]);
    expect(isVendorJob("PO Payment")).toBe(false);
    expect(isVendorJob("po inward")).toBe(true);
  });

  it("NOT DELIVERED on outward only", () => {
    expect(flagsFor({ direction: "OUT", job_type: null }, { ...base, notDelivered: true })).toEqual([FLAG.NOT_DELIVERED]);
    expect(flagsFor({ direction: "IN", job_type: null }, { ...base, notDelivered: true })).toEqual([]);
  });

  it("GUARD OFF-SHIFT only when no guard signed in all day, on a gate-app city", () => {
    const v = { direction: "OUT", job_type: null, present_p: false };
    expect(flagsFor(v, { ...base, guardOnDuty: false })).toEqual([FLAG.GUARD_OFF_SHIFT]);
    expect(flagsFor(v, { ...base, guardOnDuty: true })).toEqual([]);
    expect(flagsFor(v, { ...base, guardOnDuty: null })).toEqual([]); // paper register
  });

  it("Odoo's window runs past a week-off to 3pm on the next open day", () => {
    const cal = { weeklyOff: { DELHI: [4] }, holidays: {} };
    // Wed 16 Sep → Thu 17 is off → Fri 18 Sep 15:00 IST.
    expect(odooWindowEnd("DELHI", "2026-09-16", cal)).toBe(Date.parse("2026-09-18T15:00:00+05:30"));
    expect(odooWindowEnd("BANGALORE", "2026-09-16", cal)).toBe(Date.parse("2026-09-17T15:00:00+05:30"));
    expect(odooWindowEnd("DELHI", "2026-09-01", cal)).toBeNull(); // before the calendar-day cutover
  });
});
