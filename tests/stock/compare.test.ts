import { describe, expect, it } from "vitest";
import { attributeCleared, diffPasses, suppressUntrustworthy, unitsOf } from "../../lib/stock/compare";
import { foldPass, type PassCitySnapshot } from "../../lib/stock/snapshot";
import { assessComparability } from "../../lib/stock/coverage";
import { VARIANCE } from "../../lib/engine/variance-names";

const coverage = (movements = 100) => ({
  P: true, S: true, D: true, O: true,
  movements,
  sheetTruncated: false,
  rows: { sheetIn: 0, sheetOut: 0, odooIn: 0, odooOut: 0, dtIn: 0, dtOut: 0, physIn: 0, physOut: 0 },
});

/** Full natural key, exactly as flaggedKeyOf builds it. */
const key = (city: string, barcode: string, name: string = VARIANCE.GATE_ONLY) =>
  `${city}|OUT|${barcode}|${name}`;

function snapshot(
  city: string,
  tier1Keys: string[],
  tier3Keys: string[] = [],
  over: Partial<PassCitySnapshot> = {}
): PassCitySnapshot {
  return {
    runId: "r", businessDate: "2026-07-26", city,
    emittedCount: tier1Keys.length + tier3Keys.length,
    tier1: tier1Keys.length, tier2: 0, tier3: tier3Keys.length,
    flagged: tier1Keys.length,
    byVariance: {}, supersededCount: 0, resolvedLateCount: 0,
    coverage: coverage(),
    tier1Keys, tier2Keys: [], tier3Keys,
    keysTruncated: false, keysPruned: false, backfilled: false,
    ...over,
  };
}

const fold = (id: string, rows: PassCitySnapshot[]) => foldPass(id, "2026-07-26", rows);

describe("the three sets", () => {
  it("partitions A into still open and cleared, and B into still open and newly raised", () => {
    const a = fold("A", [snapshot("DELHI", [key("DELHI", "CF1"), key("DELHI", "CF2"), key("DELHI", "CF3")])]);
    const b = fold("B", [snapshot("DELHI", [key("DELHI", "CF2"), key("DELHI", "CF9")])]);
    const d = diffPasses(a, b);

    expect(d.flaggedA).toBe(3);
    expect(d.flaggedB).toBe(2);
    expect(d.stillOpen).toBe(1);
    expect(d.cleared).toBe(2);
    expect(d.newlyRaised).toBe(1);

    // The identities a reader can check on screen.
    expect(d.flaggedA).toBe(d.stillOpen + d.cleared);
    expect(d.flaggedB).toBe(d.stillOpen + d.newlyRaised);
    expect(d.flaggedB - d.flaggedA).toBe(d.newlyRaised - d.cleared);
  });

  it("never produces a negative, because both sides are sets", () => {
    // The property compareToSnapshot cannot have: its X is an integer, so it needs
    // a moreThanReported branch and a per-city clamp. Here a set difference simply
    // cannot go below zero.
    const a = fold("A", [snapshot("DELHI", [key("DELHI", "CF1")])]);
    const b = fold("B", [snapshot("DELHI", [key("DELHI", "CF1"), key("DELHI", "CF2"), key("DELHI", "CF3")])]);
    const d = diffPasses(a, b);
    expect(d.cleared).toBe(0);
    expect(d.newlyRaised).toBe(2);
  });

  it("sums per city to the overall EXACTLY", () => {
    const a = fold("A", [
      snapshot("DELHI", [key("DELHI", "CF1"), key("DELHI", "CF2")]),
      snapshot("PUNE", [key("PUNE", "CF3")]),
    ]);
    const b = fold("B", [
      snapshot("DELHI", [key("DELHI", "CF1")]),
      snapshot("PUNE", [key("PUNE", "CF3"), key("PUNE", "CF4")]),
    ]);
    const d = diffPasses(a, b);
    const sum = (f: (c: (typeof d.cities)[number]) => number) => d.cities.reduce((n, c) => n + f(c), 0);
    expect(sum((c) => c.flaggedA)).toBe(d.flaggedA);
    expect(sum((c) => c.cleared)).toBe(d.cleared);
    expect(sum((c) => c.stillOpen)).toBe(d.stillOpen);
    expect(sum((c) => c.newlyRaised)).toBe(d.newlyRaised);
  });
});

describe("matching on the unit, not the row", () => {
  it("keeps a superseded-but-still-broken unit in STILL OPEN", () => {
    // THE regression guard. resolveStaleOpenVariances DELETEs a row when the same
    // (direction, barcode) re-fires under a different name, and the replacement
    // carries a fresh identity. Full-key matching would score this unit as BOTH
    // cleared and newly raised — an error in the flattering direction, twice.
    const a = fold("A", [snapshot("DELHI", [key("DELHI", "CF1", VARIANCE.GATE_ONLY)])]);
    const b = fold("B", [snapshot("DELHI", [key("DELHI", "CF1", VARIANCE.SHEET_ONLY)])]);
    const d = diffPasses(a, b);
    expect(d.stillOpen).toBe(1);
    expect(d.cleared).toBe(0);
    expect(d.newlyRaised).toBe(0);
  });
});

describe("why a cleared item cleared", () => {
  const a = fold("A", [
    snapshot("DELHI", [key("DELHI", "CF1"), key("DELHI", "CF2"), key("DELHI", "CF3")]),
  ]);
  const b = fold("B", [snapshot("DELHI", [], [key("DELHI", "CF2")])]);

  it("splits human action from the system clearing itself", () => {
    const cleared = ["DELHI|OUT|CF1", "DELHI|OUT|CF2", "DELHI|OUT|CF3"];
    const at = attributeCleared(cleared, b, new Set(["DELHI|OUT|CF1"]));
    expect(at.humanClosed).toBe(1); // someone settled it
    expect(at.engineCleared).toBe(1); // fell to tier 3 — a late entry filled the gap
    expect(at.noLongerFlagged).toBe(1); // no row at all in B
    expect(at.humanClosed + at.engineCleared + at.noLongerFlagged).toBe(cleared.length);
  });

  it("prefers the human answer when both could apply", () => {
    // A closed row is a decided row, whatever the engine later thought of it —
    // the same asymmetry isStillOpen encodes.
    const at = attributeCleared(["DELHI|OUT|CF2"], b, new Set(["DELHI|OUT|CF2"]));
    expect(at.humanClosed).toBe(1);
    expect(at.engineCleared).toBe(0);
  });
});

describe("suppression", () => {
  const a = fold("A", [snapshot("DELHI", [key("DELHI", "CF1"), key("DELHI", "CF2")], [], {
    coverage: coverage(100),
  })]);
  const b = fold("B", [snapshot("DELHI", [key("DELHI", "CF1")], [], {
    coverage: { ...coverage(20), D: false },
  })]);

  it("blanks every change figure the guard cannot stand behind", () => {
    const guard = assessComparability(a, b, "2026-07-26");
    const out = suppressUntrustworthy(diffPasses(a, b), guard);

    // null, never 0. A zero here would read as "nothing was fixed" rather than
    // "we cannot say", which is the whole failure this page exists to avoid.
    expect(out.cleared).toBeNull();
    expect(out.stillOpen).toBeNull();
    expect(out.cities[0].cleared).toBeNull();

    // Each run's OWN finding survives — that is the two-independent-totals fallback.
    expect(out.flaggedA).toBe(2);
    expect(out.flaggedB).toBe(1);
  });

  it("suppresses the attribution with its total, not separately", () => {
    // "38 closed by your team" published under a suppressed `cleared` would restore
    // the refused claim by the back door.
    const guard = assessComparability(a, b, "2026-07-26");
    const out = suppressUntrustworthy(diffPasses(a, b), guard);
    expect(out.attribution).toBeNull();
  });

  it("publishes everything when both checks read the same books", () => {
    const clean = fold("B", [snapshot("DELHI", [key("DELHI", "CF1")])]);
    const guard = assessComparability(a, clean, "2026-07-26");
    const out = suppressUntrustworthy(diffPasses(a, clean), guard);
    expect(out.cleared).toBe(1);
    expect(out.attribution).not.toBeNull();
  });
});

describe("the drill-down key lists", () => {
  const a = fold("A", [snapshot("DELHI", [key("DELHI", "CF1"), key("DELHI", "CF2")])]);
  const b = fold("B", [snapshot("DELHI", [key("DELHI", "CF2"), key("DELHI", "CF3")])]);

  it("returns exactly the units behind each cell", () => {
    expect(unitsOf(a, b, "cleared")).toEqual(["DELHI|OUT|CF1"]);
    expect(unitsOf(a, b, "still-open")).toEqual(["DELHI|OUT|CF2"]);
    expect(unitsOf(a, b, "newly-raised")).toEqual(["DELHI|OUT|CF3"]);
  });

  it("agrees with the counts it drills into", () => {
    const d = diffPasses(a, b);
    expect(unitsOf(a, b, "cleared")).toHaveLength(d.cleared);
    expect(unitsOf(a, b, "still-open")).toHaveLength(d.stillOpen);
    expect(unitsOf(a, b, "newly-raised")).toHaveLength(d.newlyRaised);
  });
});

describe("keys that were never stored", () => {
  it("marks the pass unusable rather than reading null as empty", () => {
    // NULL means "not stored or pruned"; [] means "genuinely none". A consumer that
    // conflates them reports every unit as cleared.
    const a = fold("A", [snapshot("DELHI", [key("DELHI", "CF1")], [], { tier1Keys: null })]);
    const b = fold("B", [snapshot("DELHI", [key("DELHI", "CF1")])]);
    expect(a.keysUnavailable).toBe(true);
    expect(diffPasses(a, b).keysUnknown).toBe(true);
  });
});
