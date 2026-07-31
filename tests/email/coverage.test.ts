import { describe, expect, it } from "vitest";
import {
  fullyReported,
  topMissing,
  type CityCoverage,
  type FourWayCoverage,
} from "../../lib/email/digest/coverage";
import { buildSections, visibleStrings, type DigestData } from "../../lib/email/digest";

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

describe("the four-way section", () => {
  it("draws the split and never calls it a pass rate", () => {
    const t = textOf(digest({ date: "2026-07-30", cities: [city()] }));
    expect(t).toContain("1 · Four-way check");
    expect(t).toContain("23 in all four");
    expect(t).toContain("no gate register on 51 of them");
    // The line that stops 15% being read as "85% of stock is missing".
    expect(t).toContain("paperwork gap, not missing stock");
  });

  it("refuses to score a city whose source did not file", () => {
    // Scoring against the books that DID file would draw a longer bar than a
    // city with all four — an outage rendering as an improvement.
    const t = textOf(
      digest({
        date: "2026-07-30",
        cities: [city(), city({ city: "BANGALORE", reported: { P: true, S: false, D: true, O: true } })],
      })
    );
    expect(t).toContain("Not comparable — the ops sheet did not file.");
    expect(t).not.toContain("Bangalore — 150 units");
  });

  it("marks a city shut for its weekly off", () => {
    // 2026-07-30 is a Thursday; Pune is closed.
    const t = textOf(
      digest({ date: "2026-07-30", cities: [city(), city({ city: "PUNE", total: 0 })] })
    );
    expect(t).toContain("Weekly off — nothing expected.");
  });

  it("says which day it measured when that is not the day reported", () => {
    const t = textOf(digest({ date: "2026-07-28", cities: [city()] }));
    expect(t).toContain("28 July 2026 is the most recent day with all four records in");
  });

  it("stays quiet about the date when it matches the reported day", () => {
    const t = textOf(digest({ date: "2026-07-30", cities: [city()] }));
    expect(t).not.toContain("most recent day with all four records in");
  });

  it("omits the whole section when no city can be scored", () => {
    // An absent claim beats an unevidenced one: no heading, no empty table.
    const t = textOf(
      digest({
        date: "2026-07-30",
        cities: [city({ reported: { P: false, S: false, D: true, O: true } })],
      })
    );
    expect(t).not.toContain("Four-way check");
  });

  it("omits the section when there is no ledger at all", () => {
    expect(textOf(digest(undefined))).not.toContain("Four-way check");
  });
});
