import { describe, expect, it } from "vitest";
import {
  MIN_MOVEMENTS,
  cityRateLine,
  closedCaption,
  queueCaption,
  rateCaption,
  type StatLike,
} from "../../lib/ui/stat-captions";

const agg = (over: Partial<StatLike> = {}): StatLike => ({
  real: 18,
  movements: 1204,
  openReal: 12,
  closedReal: 6,
  openOver3d: 2,
  oldestOpenAt: null,
  ...over,
});

describe("rateCaption", () => {
  it("leads with how often it bites, not with a percentage", () => {
    expect(rateCaption(agg())).toBe("1 in 67 units moved · 98.5% traced");
  });

  it("refuses to score a day with no denominator", () => {
    // A zero denominator is not a perfect day; it means nothing moved or the
    // day was never counted.
    expect(rateCaption(agg({ movements: 0 }))).toBe("No movements recorded for this day");
  });

  it("says so plainly when nothing was lost", () => {
    expect(rateCaption(agg({ real: 0 }))).toBe("All 1,204 units that moved can be traced");
  });

  it("declines to compare a sample too thin to mean anything", () => {
    const thin = agg({ movements: MIN_MOVEMENTS - 1, real: 1 });
    expect(rateCaption(thin)).toContain("too few to compare");
    expect(rateCaption(thin)).not.toContain("%");
  });

  it("is silent with no aggregate at all", () => {
    expect(rateCaption(null)).toBe("");
    expect(rateCaption(undefined)).toBe("");
  });
});

describe("closedCaption", () => {
  // The tile this sits under used to count EVERY bucket while `real` counted
  // losses, so the ratio could exceed 100% and the tile was left relating
  // itself to nothing. Both are loss-only now, so the denominator is honest.
  it("gives the day's list as the denominator", () => {
    expect(closedCaption(agg({ real: 68, closedReal: 31 }))).toBe(
      "of 68 raised on this day's list"
    );
  });

  it("distinguishes 'none settled yet' from 'nothing to settle'", () => {
    expect(closedCaption(agg({ real: 68, closedReal: 0 }))).toBe("None of 68 settled yet");
    expect(closedCaption(agg({ real: 0, closedReal: 0 }))).toBe("Nothing was flagged on this day");
  });

  it("never implies a denominator it does not have", () => {
    expect(closedCaption(null)).toBe("");
  });
});

describe("queueCaption", () => {
  it("says how stale the queue is, not just how big", () => {
    // 23 raised this afternoon and 23 sitting a week are the same count and
    // only one is a problem.
    expect(queueCaption(agg({ openReal: 23, openOver3d: 6, oldestOpenAt: null }))).toContain(
      "6 older than 3 days"
    );
  });

  it("has a sentence for an empty queue and for a fresh one", () => {
    expect(queueCaption(agg({ openReal: 0 }))).toBe("Nothing left open");
    expect(queueCaption(agg({ openReal: 5, openOver3d: 0 }))).toBe("All raised today");
  });
});

describe("cityRateLine", () => {
  it("carries the count and the denominator together", () => {
    expect(cityRateLine(agg())).toContain("18 of 1,204 units moved");
  });

  it("holds the same thin-sample bar as the tile above it", () => {
    expect(cityRateLine(agg({ movements: 12, real: 1 }))).toContain("too few to compare");
  });
});
