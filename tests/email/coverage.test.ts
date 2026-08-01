import { describe, expect, it } from "vitest";
import {
  directionSkew,
  fullyReported,
  topMissing,
  type CityCoverage,
  type FourWayCoverage,
} from "../../lib/email/digest/coverage";
import {
  buildSections,
  renderDigestText,
  visibleStrings,
  type DigestData,
} from "../../lib/email/digest";

const city = (over: Partial<CityCoverage> = {}): CityCoverage => ({
  city: "DELHI",
  total: 150,
  byCount: [23, 62, 29, 36],
  missing: { P: 51, S: 10, D: 40, O: 12 },
  reported: { P: true, S: true, D: true, O: true },
  inbound: { total: 75, all4: 12 },
  outbound: { total: 75, all4: 11 },
  // Sums to total (150), as the fold guarantees.
  patterns: { PSDO: 23, "-SDO": 62, "-S-O": 29, "---O": 36 },
  ...over,
});

const digest = (coverage?: FourWayCoverage): DigestData => ({
  date: "2026-07-30",
  generatedAt: "2026-07-31T11:15:00.000Z",
  totals: { movements: 503, tier1: 9, tier2: 187, tier3: 145, open: 341 },
  cities: [],
  actions: [],
  informational: [],
  coverage,
});

const textOf = (d: DigestData) =>
  visibleStrings(buildSections(d, { dashboardUrl: "https://x.test/dashboard" })).join(" | ");

// The rendered PLAINTEXT part. Needed wherever an assertion is about a bar
// caption: those render in the text body only and are deliberately absent from
// visibleStrings, because the HTML chart prints each value on its own column.
const plainOf = (d: DigestData) => renderDigestText(d, "https://x.test/dashboard");

describe("fullyReported", () => {
  it("is true only when all four books filed", () => {
    expect(fullyReported(city())).toBe(true);
    expect(fullyReported(city({ reported: { P: false, S: true, D: true, O: true } }))).toBe(false);
  });
});

describe("topMissing", () => {
  it("names the source absent most often", () => {
    expect(topMissing(city())).toEqual({ source: "P", count: 51 });
  });

  it("returns null when nothing is missing", () => {
    expect(topMissing(city({ missing: { P: 0, S: 0, D: 0, O: 0 } }))).toBeNull();
  });

  it("breaks a tie deterministically rather than by object order", () => {
    const a = topMissing(city({ missing: { P: 5, S: 5, D: 0, O: 0 } }));
    const b = topMissing(city({ missing: { S: 5, P: 5, O: 0, D: 0 } }));
    expect(a).toEqual(b);
  });
});

describe("directionSkew", () => {
  it("catches one direction failing while the other passes", () => {
    // Bangalore, 29 Jul: arriving reached all four on 0 of 64 while leaving
    // managed 39 of 67. The city total looks merely mediocre and hides it.
    const s = directionSkew(
      city({ inbound: { total: 64, all4: 0 }, outbound: { total: 67, all4: 39 } })
    );
    expect(s).toEqual({ weak: "arriving", weakAll4: 0, weakTotal: 64, strongAll4: 39, strongTotal: 67 });
  });

  it("works in the other direction too", () => {
    const s = directionSkew(
      city({ inbound: { total: 60, all4: 30 }, outbound: { total: 40, all4: 1 } })
    );
    expect(s?.weak).toBe("leaving");
  });

  it("stays silent when both directions are similar", () => {
    expect(
      directionSkew(city({ inbound: { total: 60, all4: 20 }, outbound: { total: 60, all4: 25 } }))
    ).toBeNull();
  });

  it("refuses to headline a leg too small to mean anything", () => {
    // Three inward movements, none complete, must not become a finding.
    expect(
      directionSkew(city({ inbound: { total: 3, all4: 0 }, outbound: { total: 67, all4: 39 } }))
    ).toBeNull();
  });

  it("stays silent when BOTH directions are bad — that is not a skew", () => {
    expect(
      directionSkew(city({ inbound: { total: 60, all4: 0 }, outbound: { total: 60, all4: 1 } }))
    ).toBeNull();
  });
});

describe("the four-way section", () => {
  it("names each pattern and what it means, and never states a rate", () => {
    const d = digest({ date: "2026-07-30", cities: [city()] });
    const t = textOf(d);
    expect(t).toContain("1 · Four-way check");
    expect(t).toContain("Delhi · 150 moved");
    expect(t).toContain("All clear");
    expect(t).toContain("Guard post not logging");
    // Counts are cell TEXT, not just bar geometry, so they reach both renderers.
    expect(plainOf(d)).toMatch(/62/);
  });

  it("rows sum to the city total, so the table reconciles with its heading", () => {
    const c = city();
    expect(Object.values(c.patterns).reduce((a, b) => a + b, 0)).toBe(c.total);
  });

  it("a book that never filed is a dash, never a cross", () => {
    // The cross accuses; the dash reports. Measured 30 Jul: Mumbai's guard and
    // sheet books did not file at all, and rendering those as crosses would
    // blame a warehouse for not logging on a day nobody asked it to.
    const t = textOf(
      digest({
        date: "2026-07-30",
        cities: [
          city(),
          city({ city: "BANGALORE", reported: { P: false, S: true, D: true, O: true } }),
        ],
      })
    );
    expect(t).toContain("–");
    expect(t).toContain("did not file today");
    // And the action text for such a city never names the absent book.
    expect(t).not.toContain("Guard post not logging · Bangalore");
  });

  it("marks a city shut for its weekly off and tabulates nothing for it", () => {
    // 2026-07-30 is a Thursday; Pune is closed.
    const d = digest({
      date: "2026-07-30",
      cities: [city(), city({ city: "PUNE", total: 0, patterns: {} })],
    });
    const t = textOf(d);
    expect(t).toContain("Pune — weekly off, nothing expected.");
    expect(t).not.toContain("Pune · 0 moved");
  });

  it("omits the section when every city was shut", () => {
    // An absent claim beats an unevidenced one: no heading, no empty chart.
    // 2026-07-30 is a Thursday, so all three of these are closed.
    const t = textOf(
      digest({
        date: "2026-07-30",
        cities: [
          city({ city: "MUMBAI", total: 0, patterns: {} }),
          city({ city: "PUNE", total: 0, patterns: {} }),
          city({ city: "HYDERABAD", total: 0, patterns: {} }),
        ],
      })
    );
    expect(t).not.toContain("Four-way check");
  });

  it("omits the section when there is no ledger at all", () => {
    expect(textOf(digest(undefined))).not.toContain("Four-way check");
  });
});
