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
import { fleetWindow, normalizeAgent, vehicleFromAdhoc,
         vehicleFromTransportId } from "../../lib/gate/fleet";

describe("pulling a registration out of a DT transport reference", () => {
  // transportId is not a registration. It is a vendor code, a service code and
  // a plate joined by hyphens, spaced however whoever typed it felt at the
  // time. Every string below is real, taken from one afternoon's trips.
  it("handles the shapes DT actually contains", () => {
    const real: [string, string][] = [
      ["TC-Intra-MH12TV6748", "MH12TV6748"],
      ["CT - TA - DL1LAH6369", "DL1LAH6369"],
      ["Tarun-TA-DL1L2AG3248", "DL1L2AG3248"],
      ["Pidge -BD- KA03AL5909", "KA03AL5909"],
      ["S&S-AL-TS15U5789", "TS15U5789"],
      ["S&S - TIv30 - TS07UL5177", "TS07UL5177"],
      ["AT-TI-MH14FP2399", "MH14FP2399"],
      // The ten that the first parser dropped — 22% of the fleet. Every one
      // puts a separator somewhere a boundary-based rule cannot survive.
      ["MT - T - DL-1L-AN9769", "DL1LAN9769"],   // hyphens INSIDE the plate
      ["Vayutransport KA14C5943 ", "KA14C5943"], // no separator before the plate
      ["Pidge KA 08A 3734", "KA08A3734"],        // spaces inside the plate
      ["KT - B - HR-55-AQ 8878", "HR55AQ8878"],  // both, plus a vendor prefix
      ["Pidge KA 08 A 2871", "KA08A2871"],
      ["Vayu Transport KA53AB3631", "KA53AB3631"],
      ["TORIX 407 KA03AB7069", "KA03AB7069"],    // a number before the plate
      ["DL- KA-53-AC-2317 ", "KA53AC2317"],      // a state code before the plate
      ["NT - TA - MH12FD9355\n", "MH12FD9355"],  // a trailing newline, stored
    ];
    for (const [raw, plate] of real) expect(vehicleFromTransportId(raw), raw).toBe(plate);
  });

  it("refuses anything that is not plate-shaped", () => {
    // A wrong-looking option is worse than a missing one. A missing one sends
    // the guard to the text box; a wrong one gets tapped and recorded.
    expect(vehicleFromTransportId("")).toBeNull();
    expect(vehicleFromTransportId(null)).toBeNull();
    expect(vehicleFromTransportId("TC-Intra-")).toBeNull();
    expect(vehicleFromTransportId("VendorOnly")).toBeNull();
    expect(vehicleFromTransportId("TC-Intra-NOTAPLATE")).toBeNull();
    expect(vehicleFromTransportId("TC-Intra-123")).toBeNull();
  });

  it("accepts a hand-typed adhoc vehicle, spaced any way", () => {
    // The hired-truck case, and the original problem: one vehicle, four
    // keyboards' worth of spacing, four different strings in the register.
    const spellings = ["HR26DK8337", "HR 26 DK 8337", "hr26 dk 8337", "HR-26-DK-8337"];
    const folded = new Set(spellings.map(vehicleFromAdhoc));
    expect(folded.size).toBe(1);
    expect([...folded][0]).toBe("HR26DK8337");
  });

  it("treats an empty adhoc field as nothing", () => {
    // It is empty on almost every trip — the vendor code carries the plate.
    expect(vehicleFromAdhoc("")).toBeNull();
    expect(vehicleFromAdhoc(null)).toBeNull();
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

  it("keeps placeholders out of a list a guard is meant to trust", () => {
    for (const junk of ["NA", "n/a", "test", "none", "null", "---"]) {
      expect(normalizeAgent(junk), junk).toBeNull();
    }
  });

  it("tidies the trailing spaces DT stores", () => {
    // Real values: "Jitendra ", "Nirbhay Kushwaha ". Left alone they would show
    // as two different agents from one person.
    expect(normalizeAgent("Jitendra ")).toBe("Jitendra");
    expect(normalizeAgent("Nirbhay Kushwaha ")).toBe("Nirbhay Kushwaha");
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
