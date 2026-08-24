// The trip form's vehicle and agent lists.
//
// The two values a guard used to type into blank boxes, and the two that
// decide whether a gate row can later be matched to a planned movement. Free
// text gave one truck four spellings depending on where the spaces landed.
//
// What is pinned here is the normalisation and the WINDOW — the parts that are
// pure. The Mongo read itself is exercised against the live cluster by
// scripts/dt-fields.mjs, because a mocked driver would only prove the mock.

import { describe, expect, it } from "vitest";
import { fleetWindow, normalizeAgent, normalizeVehicle } from "../../lib/gate/fleet";

describe("a vehicle registration becomes one spelling", () => {
  it("folds the four spellings of one truck into one", () => {
    // The measured problem, exactly: same truck, four keyboards' worth of
    // spaces, and four distinct strings in the register.
    const spellings = ["HR26DK8337", "HR 26 DK 8337", "hr26 dk 8337", "HR-26-DK-8337"];
    const folded = new Set(spellings.map(normalizeVehicle));
    expect(folded.size).toBe(1);
    expect([...folded][0]).toBe("HR26DK8337");
  });

  it("rejects what cannot be a registration", () => {
    expect(normalizeVehicle("")).toBeNull();
    expect(normalizeVehicle(null)).toBeNull();
    expect(normalizeVehicle("---")).toBeNull();
    expect(normalizeVehicle("AB1")).toBeNull();                  // too short
    expect(normalizeVehicle("A".repeat(20))).toBeNull();         // too long
  });
});

describe("an agent's name is tidied, not mangled", () => {
  it("collapses stray whitespace", () => {
    expect(normalizeAgent("  Ramesh   Kumar ")).toBe("Ramesh Kumar");
  });

  it("leaves case alone", () => {
    // A guard scanning a list recognises "Ramesh Kumar". Uppercasing it to
    // match the vehicle treatment would make the list harder to read for no
    // gain — a name is not an identifier.
    expect(normalizeAgent("Ramesh Kumar")).toBe("Ramesh Kumar");
  });

  it("rejects what cannot be a name", () => {
    expect(normalizeAgent("")).toBeNull();
    expect(normalizeAgent(" ")).toBeNull();
    expect(normalizeAgent("R")).toBeNull();
    expect(normalizeAgent("x".repeat(80))).toBeNull();
  });
});

describe("the window a gate cares about", () => {
  // NOT the 15:00→15:00 business day the reconciler uses. An evening-shift
  // guard is loading tomorrow morning's trucks as often as today's, and a list
  // that ended at 15:00 would be empty for the half of the day the gate is
  // busiest.
  it("runs from this morning IST to the end of tomorrow", () => {
    // 2026-08-24 20:00 IST — an evening shift, well past the reconciler's cut.
    const { from, to } = fleetWindow(new Date("2026-08-24T14:30:00.000Z"));
    expect(from.toISOString()).toBe("2026-08-23T18:30:00.000Z"); // 24 Aug 00:00 IST
    expect(to.toISOString()).toBe("2026-08-25T18:30:00.000Z");   // 26 Aug 00:00 IST
    expect(to.getTime() - from.getTime()).toBe(2 * 86_400_000);
  });

  it("still covers today just after the 15:00 business-day cut", () => {
    // The trap this exists to avoid: at 15:30 IST the reconciler has moved on
    // to the next business day, but the guard is still loading today's trucks.
    const { from, to } = fleetWindow(new Date("2026-08-24T10:00:00.000Z")); // 15:30 IST
    expect(from.toISOString()).toBe("2026-08-23T18:30:00.000Z");
    expect(new Date("2026-08-24T12:00:00.000Z") >= from).toBe(true);
    expect(new Date("2026-08-24T12:00:00.000Z") < to).toBe(true);
  });

  it("does not roll early for a shift working past midnight IST", () => {
    // 00:30 IST on the 25th. The window is the 25th and 26th; the truck being
    // loaded right now is scheduled for the 25th, so it is still in range.
    const { from } = fleetWindow(new Date("2026-08-24T19:00:00.000Z"));
    expect(from.toISOString()).toBe("2026-08-24T18:30:00.000Z"); // 25 Aug 00:00 IST
  });
});
