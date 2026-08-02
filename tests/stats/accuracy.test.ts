import { describe, expect, it } from "vitest";
import {
  accuracyOf,
  aggregate,
  clampPct,
  dailyTotals,
  daysBefore,
  oneInN,
  scorable,
  verdictOf,
  type StatRow,
} from "../../lib/stats/accuracy";

const row = (over: Partial<StatRow> = {}): StatRow => ({
  business_date: "2026-07-29",
  city: "DELHI",
  movements: 100,
  real_count: 5,
  high_count: 2,
  ...over,
});

// 2026-07-30 is a Thursday — Mumbai, Pune and Hyderabad are shut.
// The real shape of that day, from run_city_stats.
const THIRTIETH: StatRow[] = [
  { business_date: "2026-07-30", city: "DELHI", movements: 195, real_count: 60, high_count: 60 },
  { business_date: "2026-07-30", city: "BANGALORE", movements: 218, real_count: 8, high_count: 8 },
  { business_date: "2026-07-30", city: "MUMBAI", movements: 119, real_count: 0, high_count: 0 },
  { business_date: "2026-07-30", city: "PUNE", movements: 98, real_count: 0, high_count: 0 },
  { business_date: "2026-07-30", city: "HYDERABAD", movements: 61, real_count: 0, high_count: 0 },
];

describe("accuracyOf", () => {
  it("is null, never 0, when there is no denominator", () => {
    // A closed warehouse rendered as 0% sorts to the bottom of a leaderboard for
    // having been shut.
    expect(accuracyOf(0, 0)).toBeNull();
    expect(accuracyOf(0, 3)).toBeNull();
  });

  it("reads as the share traced end to end, to one decimal", () => {
    expect(accuracyOf(1000, 14)).toBe(98.6);
    expect(accuracyOf(100, 0)).toBe(100);
  });

  it("clamps rather than going negative when real exceeds movements", () => {
    expect(accuracyOf(10, 25)).toBe(0);
    expect(clampPct(-40)).toBe(0);
    expect(clampPct(140)).toBe(100);
  });
});

describe("scorable — the shut-warehouse exclusion", () => {
  it("keeps an open city inside the window", () => {
    expect(scorable(row(), "2026-07-29", "2026-07-29")).toBe(true);
  });

  it("drops a city on its weekly off", () => {
    // Odoo still posts on a shut day while run.ts disables the Odoo-only loss
    // class, so the row arrives as (movements > 0, real = 0) and reads as 100%.
    expect(scorable(row({ city: "MUMBAI", business_date: "2026-07-30" }), "2026-07-30", "2026-07-30")).toBe(false);
    expect(scorable(row({ city: "DELHI", business_date: "2026-07-30" }), "2026-07-30", "2026-07-30")).toBe(true);
  });

  it("drops a row outside the window, either end", () => {
    expect(scorable(row(), "2026-07-30", "2026-07-31")).toBe(false);
    expect(scorable(row(), "2026-07-27", "2026-07-28")).toBe(false);
  });

  it("treats both window bounds as inclusive", () => {
    expect(scorable(row(), "2026-07-29", "2026-07-31")).toBe(true);
    expect(scorable(row({ business_date: "2026-07-31" }), "2026-07-29", "2026-07-31")).toBe(true);
  });
});

describe("aggregate and dailyTotals cannot disagree", () => {
  // THE REGRESSION THIS PINS. The leaderboard and the per-city chart went
  // through aggregate(), which excludes a shut warehouse; the analytics daily
  // trend summed the same rows inline with no exclusion at all. On 2026-07-30
  // the trend bar read 89.7% against the 82.8% its own page's KPI tile used —
  // one screen, one word, two numbers.
  it("sum to the same movements and REAL over the same window", () => {
    const byCity = [...aggregate(THIRTIETH, "2026-07-30", "2026-07-30").values()];
    const byDay = [...dailyTotals(THIRTIETH, "2026-07-30", "2026-07-30").values()];
    const sum = (xs: { movements: number; real: number }[]) => ({
      movements: xs.reduce((s, x) => s + x.movements, 0),
      real: xs.reduce((s, x) => s + x.real, 0),
    });
    expect(sum(byDay)).toEqual(sum(byCity));
  });

  it("both leave the three shut warehouses out", () => {
    const day = dailyTotals(THIRTIETH, "2026-07-30", "2026-07-30").get("2026-07-30")!;
    expect(day.movements).toBe(195 + 218); // not 691
    expect(accuracyOf(day.movements, day.real)).toBe(83.5);
    expect(aggregate(THIRTIETH, "2026-07-30", "2026-07-30").has("MUMBAI")).toBe(false);
  });

  it("keeps every city on a day nobody is shut", () => {
    const open = THIRTIETH.map((r) => ({ ...r, business_date: "2026-07-31" }));
    const day = dailyTotals(open, "2026-07-31", "2026-07-31").get("2026-07-31")!;
    expect(day.movements).toBe(691);
    expect(aggregate(open, "2026-07-31", "2026-07-31").size).toBe(5);
  });

  it("keys a multi-day window by date, not by city", () => {
    const rows = [row({ business_date: "2026-07-28" }), row({ business_date: "2026-07-29" }), row()];
    const days = dailyTotals(rows, "2026-07-28", "2026-07-29");
    expect([...days.keys()].sort()).toEqual(["2026-07-28", "2026-07-29"]);
    expect(days.get("2026-07-29")!.movements).toBe(200); // two DELHI rows same day
  });
});

describe("daysBefore", () => {
  it("counts back inclusively across a month boundary", () => {
    expect(daysBefore("2026-08-02", 6)).toBe("2026-07-27");
    expect(daysBefore("2026-07-31", 0)).toBe("2026-07-31");
  });

  it("crosses a leap day without drifting", () => {
    expect(daysBefore("2028-03-01", 1)).toBe("2028-02-29");
  });
});

describe("oneInN", () => {
  it("says how often it bites, and stays silent when it does not", () => {
    expect(oneInN(490, 10)).toBe(49);
    expect(oneInN(100, 0)).toBeNull(); // a clean day has its own sentence
    expect(oneInN(0, 5)).toBeNull();
  });
});

describe("verdictOf", () => {
  it("is a word, with a deadband matching the leaderboard's trend arrow", () => {
    expect(verdictOf(98.6, 98.0)).toBe("better");
    expect(verdictOf(98.0, 98.6)).toBe("worse");
    expect(verdictOf(98.6, 98.55)).toBe("usual");
  });

  it("says nothing when either side has no rate", () => {
    expect(verdictOf(null, 98)).toBeNull();
    expect(verdictOf(98, null)).toBeNull();
  });
});
