import { describe, expect, it } from "vitest";
import { foldCalendar, parseDmy } from "../../lib/connectors/warehouse-calendar";
import { isCityClosed, lastWorkingDay, nextWorkingDay, registerDueOn } from "../../lib/engine/schedule";

// The real rows, verified live against the delivery app on 2026-07-31.
const WEEKLY = [
  { city: "Bangalore", status: false, "week day": "Thu" },
  { city: "Pune", status: true, "week day": "Thu" },
  { city: "Noida", status: false, "week day": "Thu" },
  { city: "Hyderabad", status: true, "week day": "Thu" },
  { city: "Gurgaon", status: false, "week day": "Thu" },
  { city: "Mumbai", status: true, "week day": "Thu" },
];
const HOLIDAYS = [
  { date: "26/1/2026", status: false, city: ["Mumbai", "Pune"] }, // switched off
  { date: "11/7/2026", status: true, city: ["Pune"] },
];

describe("parseDmy", () => {
  it("reads day first, which the real rows pin beyond argument", () => {
    // 26 January and 15 August are Republic Day and Independence Day. Read
    // month-first they land in December and mid-year, silently moving a closure.
    expect(parseDmy("26/1/2026")).toBe("2026-01-26");
    expect(parseDmy("15/8/2025")).toBe("2025-08-15");
    expect(parseDmy("4/3/2026")).toBe("2026-03-04");
  });

  it("refuses anything it cannot read rather than guessing", () => {
    expect(parseDmy("2026-01-26")).toBeNull();
    expect(parseDmy("32/1/2026")).toBeNull();
    expect(parseDmy("")).toBeNull();
    expect(parseDmy(undefined)).toBeNull();
  });
});

describe("foldCalendar", () => {
  const cal = foldCalendar(WEEKLY, HOLIDAYS);

  it("reproduces the hardcoded map exactly, from data", () => {
    expect(cal.weeklyOff.MUMBAI).toEqual([4]);
    expect(cal.weeklyOff.PUNE).toEqual([4]);
    expect(cal.weeklyOff.HYDERABAD).toEqual([4]);
    expect(cal.weeklyOff.DELHI).toBeUndefined();
    expect(cal.weeklyOff.BANGALORE).toBeUndefined();
  });

  it("treats status=false as a switched-off RULE, not a working day", () => {
    // Both Bangalore and Gurgaon carry a Thursday row with status false.
    expect(cal.weeklyOff.BANGALORE).toBeUndefined();
  });

  it("closes a city only when EVERY warehouse feeding it closes", () => {
    // Gurgaon and Noida are different buildings that both normalise to DELHI.
    // One shut and one open is a working city; marking it off would suppress
    // real findings for the warehouse that ran all day.
    const split = foldCalendar(
      [
        { city: "Gurgaon", status: true, "week day": "Thu" },
        { city: "Noida", status: false, "week day": "Thu" },
      ],
      []
    );
    expect(split.weeklyOff.DELHI).toBeUndefined();

    const both = foldCalendar(
      [
        { city: "Gurgaon", status: true, "week day": "Thu" },
        { city: "Noida", status: true, "week day": "Thu" },
      ],
      []
    );
    expect(both.weeklyOff.DELHI).toEqual([4]);
  });

  it("keeps only active holidays, and spreads them across every listed city", () => {
    expect(cal.holidays.PUNE).toEqual(["2026-07-11"]);
    expect(cal.holidays.MUMBAI).toBeUndefined(); // its only row was status=false
  });
});

describe("isCityClosed", () => {
  const cal = foldCalendar(WEEKLY, HOLIDAYS);

  it("agrees with the hardcoded rule on a Thursday", () => {
    expect(isCityClosed("MUMBAI", "2026-07-30", cal)).toBe(true); // Thursday
    expect(isCityClosed("DELHI", "2026-07-30", cal)).toBe(false);
  });

  it("knows a public holiday the hardcoded map cannot", () => {
    // 11 Jul 2026 is a Saturday — no weekly rule touches it.
    expect(isCityClosed("PUNE", "2026-07-11", cal)).toBe(true);
    expect(isCityClosed("PUNE", "2026-07-11", null)).toBe(false);
  });

  it("falls back to the literal map when no calendar is supplied", () => {
    expect(isCityClosed("PUNE", "2026-07-30", null)).toBe(true);
    expect(isCityClosed("DELHI", "2026-07-30", null)).toBe(false);
  });
});

describe("lastWorkingDay — the register handover model", () => {
  const cal = foldCalendar(WEEKLY, HOLIDAYS);

  it("gives the off-day cities Wednesday and the others Thursday", () => {
    // THE OWNER'S RULE. Reporting Thursday 30 Jul: Delhi and Bangalore hand over
    // Thursday's register; Mumbai, Pune and Hyderabad were shut, so the book
    // they hand over is Wednesday's.
    expect(lastWorkingDay("DELHI", "2026-07-30", cal)).toBe("2026-07-30");
    expect(lastWorkingDay("BANGALORE", "2026-07-30", cal)).toBe("2026-07-30");
    expect(lastWorkingDay("MUMBAI", "2026-07-30", cal)).toBe("2026-07-29");
    expect(lastWorkingDay("PUNE", "2026-07-30", cal)).toBe("2026-07-29");
    expect(lastWorkingDay("HYDERABAD", "2026-07-30", cal)).toBe("2026-07-29");
  });

  it("is the date itself on any ordinary day", () => {
    expect(lastWorkingDay("MUMBAI", "2026-07-29", cal)).toBe("2026-07-29");
  });

  it("walks past a holiday that butts against the weekly off", () => {
    // Thursday 30 Jul off by rule, Wednesday 29 Jul off by holiday: the answer
    // is Tuesday. Subtracting one day would have stopped on a closed Wednesday.
    const stacked = foldCalendar(WEEKLY, [
      { date: "29/7/2026", status: true, city: ["Mumbai"] },
    ]);
    expect(lastWorkingDay("MUMBAI", "2026-07-30", stacked)).toBe("2026-07-28");
  });

  it("returns null rather than looping when a city is shut a fortnight", () => {
    const always = { weeklyOff: { MUMBAI: [0, 1, 2, 3, 4, 5, 6] }, holidays: {} };
    expect(lastWorkingDay("MUMBAI", "2026-07-30", always)).toBeNull();
  });
});

describe("registerDueOn — the one definition of when a book arrives", () => {
  const cal = foldCalendar(WEEKLY, HOLIDAYS);

  it("is simply the next day for a city that works tomorrow", () => {
    expect(registerDueOn("DELHI", "2026-07-30", cal)).toBe("2026-07-31");
    expect(registerDueOn("PUNE", "2026-07-28", cal)).toBe("2026-07-29");
  });

  it("skips the weekly off: Wednesday's book from a Thursday-off city lands Friday", () => {
    expect(registerDueOn("MUMBAI", "2026-07-29", cal)).toBe("2026-07-31");
  });

  it("moves another day when a holiday stacks against the weekly off", () => {
    // Thursday off by rule, Friday shut by holiday: Wednesday's book lands
    // Saturday. The old "+2" literal would have said Friday and been wrong.
    const stacked = foldCalendar(WEEKLY, [
      { date: "31/7/2026", status: true, city: ["Mumbai"] },
    ]);
    expect(registerDueOn("MUMBAI", "2026-07-29", stacked)).toBe("2026-08-01");
  });

  it("gives null rather than a guess for a city shut a fortnight", () => {
    const always = { weeklyOff: { MUMBAI: [0, 1, 2, 3, 4, 5, 6] }, holidays: {} };
    expect(registerDueOn("MUMBAI", "2026-07-29", always)).toBeNull();
  });

  it("nextWorkingDay includes `from` itself when the city works that day", () => {
    expect(nextWorkingDay("MUMBAI", "2026-07-31", cal)).toBe("2026-07-31");
    expect(nextWorkingDay("MUMBAI", "2026-07-30", cal)).toBe("2026-07-31"); // Thu shut
  });
});
