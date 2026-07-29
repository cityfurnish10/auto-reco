// The follow-up's X is "the number the recipient is looking at in their inbox".
// It cannot be recomputed later — the re-check pass overwrites the date's
// counts — so it is frozen at send time. These tests pin that contract.

import { describe, expect, it } from "vitest";
import {
  MAX_SNAPSHOT_KEYS,
  SNAPSHOT_VERSION,
  digestTotalsSnapshot,
  flaggedKeyOf,
  parseTotalsSnapshot,
  unitKeyOf,
} from "../../lib/email/followup/snapshot";
import type { DigestData } from "../../lib/email/digest/types";

const city = (name: string, tier1: number, tier2: number, tier3: number) => ({
  city: name,
  movements: 100,
  tier1,
  tier2,
  tier3,
  open: tier1 + tier2 + tier3,
  register: "received" as const,
  topRisk: null,
});

const digest = (over: Partial<DigestData> = {}): DigestData =>
  ({
    date: "2026-07-24",
    generatedAt: "2026-07-25T11:15:00.000Z",
    totals: { movements: 200, tier1: 5, tier2: 9, tier3: 20, open: 34 },
    cities: [city("DELHI", 3, 5, 12), city("MUMBAI", 2, 4, 8)],
    actions: [],
    informational: [],
    flaggedKeys: ["DELHI|OUT|CF1|Gate Register Only — No Ops / DT / Odoo Record"],
    ...over,
  }) as DigestData;

describe("digestTotalsSnapshot", () => {
  it("stores flagged rather than deriving it, so X cannot drift", () => {
    // If the follow-up recomputed tier1+tier2 from its own reading of the
    // labels, a later change to the tier map would silently change what the
    // email "said" two days ago.
    const s = digestTotalsSnapshot(digest(), "2026-07-25T11:15:12.000Z");
    expect(s.overall.flagged).toBe(14);
    expect(s.overall.flagged).toBe(s.overall.tier1 + s.overall.tier2);
    for (const c of s.cities) expect(c.flagged).toBe(c.tier1 + c.tier2);
  });

  it("records the wire moment, not the build moment", () => {
    const s = digestTotalsSnapshot(digest(), "2026-07-25T11:15:12.000Z");
    expect(s.sentAt).toBe("2026-07-25T11:15:12.000Z");
    expect(s.sentAt).not.toBe(digest().generatedAt);
  });

  it("carries the business date the email covered, not the send date", () => {
    expect(digestTotalsSnapshot(digest(), "2026-07-25T11:15:12Z").date).toBe("2026-07-24");
  });

  it("keeps every city", () => {
    const s = digestTotalsSnapshot(digest(), "2026-07-25T11:15:12Z");
    expect(s.cities.map((c) => c.city)).toEqual(["DELHI", "MUMBAI"]);
  });

  it("truncates the key list rather than storing an unbounded document", () => {
    const many = Array.from({ length: MAX_SNAPSHOT_KEYS + 50 }, (_, i) => `DELHI|OUT|CF${i}|X`);
    const s = digestTotalsSnapshot(digest({ flaggedKeys: many }), "2026-07-25T11:15:12Z");
    expect(s.keys).toHaveLength(MAX_SNAPSHOT_KEYS);
    expect(s.keysTruncated).toBe(true);
  });

  it("does not flag truncation when everything fits", () => {
    expect(digestTotalsSnapshot(digest(), "2026-07-25T11:15:12Z").keysTruncated).toBe(false);
  });

  it("survives a digest built before flaggedKeys existed", () => {
    const s = digestTotalsSnapshot(digest({ flaggedKeys: undefined }), "2026-07-25T11:15:12Z");
    expect(s.keys).toEqual([]);
  });
});

describe("keys identify the unit, not just the row", () => {
  it("builds the natural key of the variances table", () => {
    expect(
      flaggedKeyOf({ city: "DELHI", direction: "OUT", barcode: "CF1", variance_name: "Some Name" })
    ).toBe("DELHI|OUT|CF1|Some Name");
  });

  it("reduces to the unit by dropping the problem name", () => {
    // This is the whole reason keys are stored. resolveStaleOpenVariances
    // DELETEs a row when the same (direction, barcode) re-fires under a
    // different name, so matching on the full key would report a still-broken
    // unit as newly flagged — an error in the flattering direction.
    const before = flaggedKeyOf({ city: "DELHI", direction: "OUT", barcode: "CF1", variance_name: "Old Name" });
    const after = flaggedKeyOf({ city: "DELHI", direction: "OUT", barcode: "CF1", variance_name: "New Name" });
    expect(before).not.toBe(after);
    expect(unitKeyOf(before)).toBe(unitKeyOf(after));
    expect(unitKeyOf(before)).toBe("DELHI|OUT|CF1");
  });

  it("keeps different directions of one barcode apart", () => {
    const out = flaggedKeyOf({ city: "DELHI", direction: "OUT", barcode: "CF1", variance_name: "N" });
    const inn = flaggedKeyOf({ city: "DELHI", direction: "IN", barcode: "CF1", variance_name: "N" });
    expect(unitKeyOf(out)).not.toBe(unitKeyOf(inn));
  });
});

describe("parseTotalsSnapshot refuses anything it does not fully understand", () => {
  const good = digestTotalsSnapshot(digest(), "2026-07-25T11:15:12Z");

  it("round-trips a document it wrote", () => {
    expect(parseTotalsSnapshot(JSON.parse(JSON.stringify(good)))).toEqual(good);
  });

  it("returns null rather than guessing", () => {
    // A half-understood document must never become a number in an email. The
    // follow-up skips the date instead.
    for (const bad of [
      null,
      undefined,
      {},
      "not an object",
      { ...good, v: 2 },
      { ...good, v: undefined },
      { ...good, date: 20260724 },
      { ...good, sentAt: undefined },
      { ...good, overall: { tier1: 1 } },
      { ...good, overall: { ...good.overall, flagged: "14" } },
      { ...good, cities: "DELHI" },
      { ...good, cities: [{ movements: 1 }] },
      { ...good, keys: [1, 2] },
      { ...good, keys: "a,b" },
    ]) {
      expect(parseTotalsSnapshot(bad), JSON.stringify(bad)?.slice(0, 60)).toBeNull();
    }
  });

  it("pins the version, so a future shape change cannot be misread as v1", () => {
    expect(SNAPSHOT_VERSION).toBe(1);
    expect(parseTotalsSnapshot({ ...good, v: SNAPSHOT_VERSION + 1 })).toBeNull();
  });
});
