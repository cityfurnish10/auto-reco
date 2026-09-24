// Trips at an hour the warehouse does not work.
//
// Windows set by the owner, 24 Sep 2026, against the gate app's own history
// (1 Aug – 23 Sep): outward runs 9am–noon, inward 6pm–10pm, and the reverse
// has effectively never happened.

import { describe, it, expect } from "vitest";
import { isOddHour, istHour, noteFor, type TripLike } from "../../lib/reconcile/odd-hour-trips";

/** `hhmm` in IST on 24 Sep 2026, as the UTC instant the database stores. */
const at = (hhmm: string): string => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.parse("2026-09-24T00:00:00+05:30") + (h * 60 + m) * 60_000).toISOString();
};
const trip = (direction: "IN" | "OUT", hhmm: string): TripLike => ({
  id: "t1", direction, vehicle_no: "DL1LAH0647", opened_at: at(hhmm), city: "DELHI",
});

describe("odd-hour trips", () => {
  it("reads the IST hour, not the server's", () => {
    expect(istHour(at("22:14")).clock).toBe("22:14");
    expect(istHour(at("01:05")).hour).toBe(1);
  });

  it("leaves the ordinary day alone", () => {
    // The two peaks: 123 of 141 outward trips, 103 of 124 inward.
    for (const t of ["09:00", "10:30", "11:59", "14:00", "19:45"]) {
      expect(isOddHour(trip("OUT", t))).toBe(false);
    }
    for (const t of ["18:00", "19:30", "21:59", "22:30", "12:00"]) {
      expect(isOddHour(trip("IN", t))).toBe(false);
    }
  });

  it("flags an outward in the evening or the night", () => {
    for (const t of ["20:00", "22:14", "23:59", "00:30", "07:59"]) {
      expect(isOddHour(trip("OUT", t))).toBe(true);
    }
  });

  it("flags an inward late at night or in the morning", () => {
    for (const t of ["23:00", "01:05", "06:00", "10:59"]) {
      expect(isOddHour(trip("IN", t))).toBe(true);
    }
  });

  it("names the trip, the time and the usual hours in the note", () => {
    const n = noteFor(trip("OUT", "22:14"), "Mahesh");
    expect(n).toContain("22:14");
    expect(n).toContain("DL1LAH0647");
    expect(n).toContain("Mahesh");
    expect(n).toContain("9am to noon");
  });
});
