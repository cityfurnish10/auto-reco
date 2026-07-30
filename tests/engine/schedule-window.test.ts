import { describe, expect, it } from "vitest";
import { closedPartOfWindow, isCityOff } from "../../lib/engine/schedule";

// 2026-07-29 Wed · 2026-07-30 Thu · 2026-07-31 Fri
describe("a one-day closure lands inside TWO business dates", () => {
  it("marks the Thursday itself as off", () => {
    expect(isCityOff("MUMBAI", "2026-07-30")).toBe(true);
    expect(isCityOff("PUNE", "2026-07-30")).toBe(true);
    expect(isCityOff("HYDERABAD", "2026-07-30")).toBe(true);
  });

  it("marks WEDNESDAY as partly shut, which isCityOff cannot see", () => {
    // Business date Wed runs Wed 15:00 -> Thu 15:00, so its morning half is the
    // holiday. The dashboard showed these three unmarked on the Wednesday board
    // while their floor sources were quiet.
    for (const c of ["MUMBAI", "PUNE", "HYDERABAD"] as const) {
      expect(isCityOff(c, "2026-07-29"), `${c} isCityOff Wed`).toBe(false);
      expect(closedPartOfWindow(c, "2026-07-29"), `${c} partial Wed`).toBe(true);
    }
  });

  it("never reports partial for a city that works seven days", () => {
    for (const d of ["2026-07-29", "2026-07-30", "2026-07-31"]) {
      expect(closedPartOfWindow("DELHI", d)).toBe(false);
      expect(closedPartOfWindow("BANGALORE", d)).toBe(false);
    }
  });

  it("does not double-report the off day itself as partial", () => {
    // Thursday is already the strong "Weekly off" state; showing both would put
    // two contradictory markers on one card.
    expect(closedPartOfWindow("MUMBAI", "2026-07-30")).toBe(false);
  });

  it("is quiet on an ordinary midweek day", () => {
    expect(closedPartOfWindow("MUMBAI", "2026-07-27")).toBe(false);
    expect(isCityOff("MUMBAI", "2026-07-27")).toBe(false);
  });

  it("shrugs off a malformed date rather than throwing", () => {
    expect(closedPartOfWindow("MUMBAI", "")).toBe(false);
    expect(closedPartOfWindow("MUMBAI", "not-a-date")).toBe(false);
  });
});
