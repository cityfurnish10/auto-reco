import { describe, expect, it } from "vitest";
import {
  detectDateOrder,
  parseDisplayDate,
  resolveSheetDate,
} from "../../lib/connectors/sheets-mapping";

describe("parseDisplayDate — timezone-safe, day-first-when-ambiguous", () => {
  it("reads ISO and unambiguous D/M or M/D", () => {
    expect(parseDisplayDate("2026-07-12")).toBe("2026-07-12");
    expect(parseDisplayDate("13-07-2026")).toBe("2026-07-13"); // 13>12 → day-first forced
    expect(parseDisplayDate("7/13/2026")).toBe("2026-07-13"); // 13>12 → month-first forced
  });

  it("defaults ambiguous both-≤12 to day-first (India)", () => {
    expect(parseDisplayDate("12-07-2026")).toBe("2026-07-12");
    expect(parseDisplayDate("05/06/2026")).toBe("2026-06-05");
  });

  it("never drifts a day (the old Date.parse+toISOString bug)", () => {
    // "7/13/2026" once resolved to 2026-07-12 via a UTC shift — must not.
    expect(parseDisplayDate("7/13/2026")).not.toBe("2026-07-12");
  });
});

describe("detectDateOrder — field order from a sheet's own recent rows", () => {
  it("DELHI recent rows (7/13, 7/14, 7/25) → month-first", () => {
    expect(detectDateOrder(["7/13/2026", "7/14/2026", "7/12/2026", "7/25/2026"])).toBe("MDY");
  });

  it("HYD recent rows (13-07, 14-07, 25-07) → day-first", () => {
    expect(detectDateOrder(["13-07-2026", "14-07-2026", "12-07-2026", "25-07-2026"])).toBe("DMY");
  });

  it("all-ambiguous sample → null (caller defaults day-first)", () => {
    expect(detectDateOrder(["07-12-2026", "05-06-2026"])).toBeNull();
  });
});

describe("resolveSheetDate — run-month anchor ('7 = July') + citywise order", () => {
  const RUN = "2026-07-12";

  it("DELHI (month-first '7/12'): 7 = July → 12 Jul; the 13th stays the 13th", () => {
    expect(resolveSheetDate(46215, "7/12/2026", "MDY", RUN)).toBe("2026-07-12");
    expect(resolveSheetDate(46216, "7/13/2026", "MDY", RUN)).toBe("2026-07-13");
  });

  it("HYD (day-first '12-07'): 07 = July → 12 Jul despite corrupt serial (46363=7 Dec)", () => {
    expect(resolveSheetDate(46363, "12-07-2026", "DMY", RUN)).toBe("2026-07-12");
  });

  it("MUM (month-first sheet, operator typed '12/7' meaning 12 Jul): anchor recovers 12 Jul", () => {
    // The killer case: sheet order is MDY so "12/7" renders/stores as 7 Dec,
    // but the run-month anchor reads the 7 as July → 12 Jul.
    expect(resolveSheetDate(46363, "12/7/2026", "MDY", RUN)).toBe("2026-07-12");
  });

  it("an unambiguous field (>12) is always the day, regardless of order", () => {
    expect(resolveSheetDate(null, "13-07-2026", "MDY", RUN)).toBe("2026-07-13");
    expect(resolveSheetDate(null, "7/13/2026", "DMY", RUN)).toBe("2026-07-13");
  });

  it("an ambiguous non-run-month date falls back to the sheet's order (and is filtered out)", () => {
    // "05/06" with runMonth 7 → neither field is 7 → use order.
    expect(resolveSheetDate(null, "05/06/2026", "DMY", RUN)).toBe("2026-06-05");
    expect(resolveSheetDate(null, "05/06/2026", "MDY", RUN)).toBe("2026-05-06");
  });

  it("no parseable display → the raw serial", () => {
    expect(resolveSheetDate(46215, "", null, RUN)).toBe("2026-07-12");
  });
});
