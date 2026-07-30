import { describe, expect, it } from "vitest";
import { assessComparability, MOVEMENT_TOLERANCE } from "../../lib/stock/coverage";
import type { Coverage, FoldedPass, PassCitySnapshot } from "../../lib/stock/snapshot";

// The file this suite exists for. Every assertion here is about refusing to call
// a source outage "progress".

const cov = (
  mask: Partial<Coverage>,
  movements: number
): Coverage => ({
  P: true, S: true, D: true, O: true,
  movements,
  sheetTruncated: false,
  rows: { sheetIn: 0, sheetOut: 0, odooIn: 0, odooOut: 0, dtIn: 0, dtOut: 0, physIn: 0, physOut: 0 },
  ...mask,
});

const snap = (city: string, coverage: Coverage, flagged = 0): PassCitySnapshot => ({
  runId: "r", businessDate: "2026-07-26", city,
  emittedCount: flagged, tier1: flagged, tier2: 0, tier3: 0, flagged,
  byVariance: {}, supersededCount: 0, resolvedLateCount: 0,
  coverage,
  tier1Keys: [], tier2Keys: [], tier3Keys: [],
  keysTruncated: false, keysPruned: false, backfilled: false,
});

const fold = (runId: string, rows: PassCitySnapshot[]): FoldedPass => ({
  runId,
  date: "2026-07-26",
  cities: new Map(rows.map((r) => [r.city, r])),
  flaggedUnits: new Set(),
  tier3Units: new Set(),
  keyOfUnit: new Map(),
  flaggedCount: rows.reduce((n, r) => n + r.flagged, 0),
  keysUnavailable: false,
  backfilled: false,
});

describe("the 26 July case", () => {
  // A run reading real=101 and another reading real=26, the second status='partial'.
  // A naive diff prints "75 items fixed". Nothing was fixed — a source was down.
  // If this test ever passes with clearedTrustworthy true, the page is lying.
  it("refuses to call a lost source a resolution", () => {
    const a = fold("A", [snap("DELHI", cov({}, 101), 101)]);
    const b = fold("B", [snap("DELHI", cov({ D: false }, 26), 26)]);
    const g = assessComparability(a, b, "2026-07-26");

    expect(g.clearedTrustworthy).toBe(false);
    expect(g.perCity[0].verdict).toBe("narrowed");
    expect(g.perCity[0].lostInB).toEqual(["D"]);
    expect(g.headline).toContain("delivery app");
  });

  it("catches the same collapse even when every book still answered", () => {
    // The boolean mask alone is not enough: a source returning one row reads as
    // REPORTED. That is the failure sheet-guard.ts exists for.
    const a = fold("A", [snap("DELHI", cov({}, 101), 101)]);
    const b = fold("B", [snap("DELHI", cov({}, 26), 26)]);
    expect(assessComparability(a, b, "2026-07-26").clearedTrustworthy).toBe(false);
  });
});

describe("the 25 July case", () => {
  // 422 -> 397 is −5.9%: genuine day-over-day noise, and blocking it would make
  // the page refuse almost every real comparison.
  it("accepts ordinary movement drift", () => {
    const a = fold("A", [snap("DELHI", cov({}, 422), 422)]);
    const b = fold("B", [snap("DELHI", cov({}, 397), 397)]);
    const g = assessComparability(a, b, "2026-07-25");
    expect(g.clearedTrustworthy).toBe(true);
    expect(g.perCity[0].verdict).toBe("ok");
  });

  it("puts the threshold where both live cases land on the right side", () => {
    expect(MOVEMENT_TOLERANCE).toBe(0.1);
    const at = (n: number) =>
      assessComparability(
        fold("A", [snap("DELHI", cov({}, 100), 0)]),
        fold("B", [snap("DELHI", cov({}, n), 0)]),
        "2026-07-25"
      ).clearedTrustworthy;
    expect(at(90)).toBe(true);
    expect(at(89)).toBe(false);
  });
});

describe("which direction is untrustworthy", () => {
  it("blocks only NEWLY RAISED when the FIRST check saw less", () => {
    // The mirror case: extra items at B were always there, not newly wrong.
    const a = fold("A", [snap("DELHI", cov({ D: false }, 40), 10)]);
    const b = fold("B", [snap("DELHI", cov({}, 100), 60)]);
    const g = assessComparability(a, b, "2026-07-25");
    expect(g.newlyRaisedTrustworthy).toBe(false);
    expect(g.clearedTrustworthy).toBe(true);
    expect(g.perCity[0].verdict).toBe("widened");
  });

  it("blocks both when each check lost a different book", () => {
    const a = fold("A", [snap("DELHI", cov({ S: false }, 100), 10)]);
    const b = fold("B", [snap("DELHI", cov({ D: false }, 100), 10)]);
    const g = assessComparability(a, b, "2026-07-25");
    expect(g.clearedTrustworthy).toBe(false);
    expect(g.newlyRaisedTrustworthy).toBe(false);
    expect(g.perCity[0].verdict).toBe("incomparable");
  });
});

describe("absences that are not outages", () => {
  it("treats a weekly-off warehouse as expected, not broken", () => {
    // 2026-07-30 is a Thursday. Mumbai, Pune and Hyderabad close then; scoring that
    // as an outage would blank three of five cities every single week.
    const a = fold("A", [snap("MUMBAI", cov({ P: false, S: false }, 0), 0)]);
    const b = fold("B", [snap("MUMBAI", cov({ P: false, S: false }, 0), 0)]);
    const g = assessComparability(a, b, "2026-07-30");
    expect(g.perCity[0].verdict).toBe("rest-day");
    expect(g.clearedTrustworthy).toBe(true);
  });

  it("still refuses when NOTHING is known, which every() would call true", () => {
    // The empty-list trap: `[].every(...)` is vacuously true, so without the
    // explicit guard a date with no cities at all would render a confident delta.
    const empty = fold("A", []);
    expect(assessComparability(empty, fold("B", []), "2026-07-25").clearedTrustworthy).toBe(false);
  });

  it("marks a city one check never reconciled as not-run, never as zero", () => {
    const a = fold("A", [snap("DELHI", cov({}, 50), 5), snap("PUNE", cov({}, 20), 2)]);
    const b = fold("B", [snap("DELHI", cov({}, 50), 5)]);
    const g = assessComparability(a, b, "2026-07-25");
    const pune = g.perCity.find((c) => c.city === "PUNE")!;
    expect(pune.verdict).toBe("not-run");
    expect(pune.clearedTrustworthy).toBe(false);
    expect(g.clearedTrustworthy).toBe(false);
  });
});

describe("one bad city blocks the overall", () => {
  it("does not publish a total computed over a subset", () => {
    const a = fold("A", [snap("DELHI", cov({}, 100), 10), snap("PUNE", cov({}, 100), 10)]);
    const b = fold("B", [snap("DELHI", cov({}, 100), 10), snap("PUNE", cov({ S: false }, 100), 2)]);
    const g = assessComparability(a, b, "2026-07-25");
    expect(g.clearedTrustworthy).toBe(false);
    expect(g.blockedCities).toEqual(["PUNE"]);
  });
});
