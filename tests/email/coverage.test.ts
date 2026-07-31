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
  it("draws the split and never calls it a pass rate", () => {
    const t = textOf(digest({ date: "2026-07-30", cities: [city()] }));
    expect(t).toContain("1 · Four-way check");
    const plain = plainOf(digest({ date: "2026-07-30", cities: [city()] }));
    expect(plain).toContain("23 in all four");
    expect(plain).toContain("no gate register on 51 of them");
    // The line that stops 15% being read as "85% of stock is missing".
    expect(t).toContain("paperwork gap, not missing stock");
  });

  it("still charts a city whose guard register did not file, and says why", () => {
    // The counts of "in three / two / one" are real measurements either way,
    // and the MISSING GREEN COLUMN is the most legible thing on the page. What
    // must never happen is scoring such a city as a RATE against one with all
    // four — agreeing across two records is easier than across four, so a rate
    // would render an outage as an improvement. Counts do not have that flaw.
    const t = textOf(
      digest({
        date: "2026-07-30",
        cities: [
          city(),
          city({ city: "BANGALORE", reported: { P: false, S: true, D: true, O: true } }),
        ],
      })
    );
    expect(t).toContain("No guard");
    expect(t).toContain("No green column for Bangalore");
    expect(t).toContain("Guard ✓"); // Delhi keeps its badge
  });

  it("marks a city shut for its weekly off and charts nothing for it", () => {
    // 2026-07-30 is a Thursday; Pune is closed.
    const d = digest({ date: "2026-07-30", cities: [city(), city({ city: "PUNE", total: 0 })] });
    const t = textOf(d);
    expect(plainOf(d)).toContain("Pune was shut — nothing expected.");
    // A shut city must not be blamed for a missing register.
    expect(t).not.toContain("No green column for Pune");
  });

  it("says which day it measured when that is not the day reported", () => {
    const t = textOf(digest({ date: "2026-07-28", cities: [city()] }));
    expect(t).toContain("28 July 2026 is the most recent day with all four records in");
  });

  it("stays quiet about the date when it matches the reported day", () => {
    const t = textOf(digest({ date: "2026-07-30", cities: [city()] }));
    expect(t).not.toContain("most recent day with all four records in");
  });

  it("omits the section when every city was shut", () => {
    // An absent claim beats an unevidenced one: no heading, no empty chart.
    // 2026-07-30 is a Thursday, so all three of these are closed.
    const t = textOf(
      digest({
        date: "2026-07-30",
        cities: [
          city({ city: "MUMBAI", total: 0 }),
          city({ city: "PUNE", total: 0 }),
          city({ city: "HYDERABAD", total: 0 }),
        ],
      })
    );
    expect(t).not.toContain("Four-way check");
  });

  it("omits the section when there is no ledger at all", () => {
    expect(textOf(digest(undefined))).not.toContain("Four-way check");
  });
});
