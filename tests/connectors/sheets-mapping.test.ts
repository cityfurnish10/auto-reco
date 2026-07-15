import { describe, expect, it } from "vitest";
import { parseDisplayDate, resolveSheetDate } from "../../lib/connectors/sheets-mapping";

const RUN = "2026-07-12";

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

describe("resolveSheetDate — reconciles a raw serial with the displayed string", () => {
  it("DELHI shape: correct serial, US M/D/Y display → trust the serial", () => {
    // serial 46215 = 2026-07-12; display "7/12/2026" (month-first)
    expect(resolveSheetDate(46215, "7/12/2026", RUN)).toBe("2026-07-12");
    // the next day's row (serial 46216 = 13 Jul) stays the 13th, not the run
    expect(resolveSheetDate(46216, "7/13/2026", RUN)).toBe("2026-07-13");
  });

  it("HYD/MUM shape: MM/DD-corrupted serial, correct India display → trust display", () => {
    // "12-07" entered as 12 Jul but stored MM-DD → serial 46363 = 7 Dec.
    expect(resolveSheetDate(46363, "12-07-2026", RUN)).toBe("2026-07-12");
  });

  it("text-typed date cell (no serial) → day-first display", () => {
    expect(resolveSheetDate("13-07-2026", "13-07-2026", RUN)).toBe("2026-07-13");
  });

  it("a genuine far-past row is not dragged onto the run date", () => {
    // serial 46180 ≈ 7 Jun; display agrees → stays June, filtered out of a July run
    const d = resolveSheetDate(46180, "07-06-2026", RUN);
    expect(d).not.toBe(RUN);
  });
});
