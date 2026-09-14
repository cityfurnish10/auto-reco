import { describe, expect, it } from "vitest";
import { istDateOf, istDayRange, istToday, shiftIstDate } from "../../lib/gate/calendar";

describe("calendar days, IST", () => {
  it("THE CONFUSION IT ENDS: this morning's trucks are on the 14th, not the 13th", () => {
    // DL1LAT 4654 left at 11:36 IST on 14 Sep — warehouse day 13 Sep.
    expect(istDateOf("2026-09-14T06:06:00Z")).toBe("2026-09-14");
    // And last evening's inward trips stay on the 13th.
    expect(istDateOf("2026-09-13T13:10:00Z")).toBe("2026-09-13");
  });

  it("midnight IST is the boundary, not midnight UTC", () => {
    expect(istDateOf("2026-09-13T18:29:59Z")).toBe("2026-09-13");   // 23:59:59 IST
    expect(istDateOf("2026-09-13T18:30:00Z")).toBe("2026-09-14");   // 00:00 IST
    expect(istToday(new Date("2026-09-13T20:00:00Z"))).toBe("2026-09-14");
  });

  it("a day's range covers exactly that IST day", () => {
    expect(istDayRange("2026-09-14")).toEqual({ from: "2026-09-13T18:30:00.000Z", to: "2026-09-14T18:30:00.000Z" });
  });

  it("steps across month ends", () => {
    expect(shiftIstDate("2026-09-30", 1)).toBe("2026-10-01");
    expect(shiftIstDate("2026-10-01", -1)).toBe("2026-09-30");
  });
});
