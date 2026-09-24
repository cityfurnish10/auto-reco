// The Delivery Tracker is read whole (owner, 24 Sep 2026).
//
// It used to be read through two private filters — three job types and any
// customer whose name or email said "cityfurnish" — applied before the rows
// reached the engine. On Delhi's 22 Sep that hid 38 outward units: the
// Tracker's own screen said 87 outward done, the tool said 49, and nothing on
// the dashboard could explain the gap. A source read through a filter of our
// own is not an independent witness.

import { describe, it, expect } from "vitest";
import { deriveDtDirection, DT_EXCLUDED_JOB_TYPES } from "../../lib/connectors/dt-mapping";

const base = { hasDeliveryId: false, hasPickupDeliveryId: false };

describe("no source-side filtering of the tracker", () => {
  it("excludes no job type", () => {
    expect(DT_EXCLUDED_JOB_TYPES).toEqual([]);
  });

  it("B2B and New - Buy get a direction like any other job", () => {
    expect(deriveDtDirection({ ...base, jobType: "B2B", hasDeliveryId: true })).toBe("OUT");
    expect(deriveDtDirection({ ...base, jobType: "New - Buy", hasDeliveryId: true })).toBe("OUT");
    expect(deriveDtDirection({ ...base, jobType: "B2B", hasPickupDeliveryId: true })).toBe("IN");
  });

  it("falls back to the link the item hangs off instead of dropping it", () => {
    // A Replace whose client status says neither "Delivery Pending" nor
    // "Replacement In" used to be dropped silently.
    expect(deriveDtDirection({ ...base, subCategory: "Replace", clientStatus: "Something else", hasDeliveryId: true })).toBe("OUT");
    expect(deriveDtDirection({ ...base, subCategory: "Replace", clientStatus: null as unknown as string, hasPickupDeliveryId: true })).toBe("IN");
  });

  it("still declines when the links cannot decide either", () => {
    expect(deriveDtDirection({ ...base })).toBeNull();
    expect(deriveDtDirection({ ...base, hasDeliveryId: true, hasPickupDeliveryId: true })).toBeNull();
  });

  it("keeps the rules that DO read the job's own words", () => {
    expect(deriveDtDirection({ ...base, jobType: "Pickup and Refund", hasDeliveryId: true })).toBe("IN");
    expect(deriveDtDirection({ ...base, category: "Order", hasPickupDeliveryId: true })).toBe("OUT");
  });
});
