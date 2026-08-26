// A city here is a WAREHOUSE, not a place.
//
// There are five physical buildings and each serves a catchment around it, so a
// Chennai delivery physically leaves through the Bangalore gate and for
// reconciliation purposes IS Bangalore. gate_sites.serves has recorded that
// since 0026; the code that maps a source's spelling to a warehouse did not.
//
// MEASURED 2026-08-26: DT carried 50 Chennai deliveries and one Hosur in a
// single week, and every one was dropped before reconciliation saw it, because
// the connector skips a row whose city it cannot place. These tests exist so
// that gap cannot reopen quietly.

import { describe, expect, it } from "vitest";
import { normalizeCity, catchmentFor } from "../../lib/connectors/types";
import { CITIES } from "../../lib/sample-data";

describe("the catchments a warehouse actually serves", () => {
  it("places the cities that were being dropped", () => {
    // Each of these appeared in real source data and resolved to nothing.
    expect(normalizeCity("Chennai")).toBe("BANGALORE");
    expect(normalizeCity("Hosur")).toBe("BANGALORE");
    expect(normalizeCity("Ghaziabad")).toBe("DELHI");
    expect(normalizeCity("Faridabad")).toBe("DELHI");
    expect(normalizeCity("Navi Mumbai")).toBe("MUMBAI");
    expect(normalizeCity("Thane")).toBe("MUMBAI");
  });

  it("still places everything it placed before", () => {
    // The original list, unchanged — widening a mapping must not move a city
    // that was already resolving correctly.
    const before: [string, string][] = [
      ["delhi", "DELHI"], ["new delhi", "DELHI"], ["ncr", "DELHI"],
      ["gurgaon", "DELHI"], ["gurugram", "DELHI"], ["noida", "DELHI"],
      ["mumbai", "MUMBAI"], ["bombay", "MUMBAI"], ["pune", "PUNE"],
      ["hyderabad", "HYDERABAD"], ["hydrabad", "HYDERABAD"], ["hyd", "HYDERABAD"],
      ["bangalore", "BANGALORE"], ["bengaluru", "BANGALORE"],
    ];
    for (const [raw, city] of before) expect(normalizeCity(raw), raw).toBe(city);
  });

  it("is case and whitespace insensitive, because sources are not tidy", () => {
    expect(normalizeCity("  CHENNAI ")).toBe("BANGALORE");
    expect(normalizeCity("Navi  Mumbai")).toBeNull();   // double space is a real miss
    expect(normalizeCity("NEW DELHI")).toBe("DELHI");
  });

  it("still refuses a place no warehouse serves", () => {
    // Jaipur appears in DT (10 rows in a week) and no warehouse claims it.
    // Silently filing it under the nearest gate would invent movements through
    // a building they never passed through.
    expect(normalizeCity("Jaipur")).toBeNull();
    expect(normalizeCity("")).toBeNull();
    expect(normalizeCity(null)).toBeNull();
    expect(normalizeCity("Atlantis")).toBeNull();
  });

  it("every warehouse names itself in its own catchment", () => {
    // Otherwise a source spelling the warehouse's own city would not resolve to
    // it, which is the kind of thing nobody checks until it breaks.
    for (const c of CITIES) {
      const names = catchmentFor(c);
      expect(names.length, `${c} has no catchment`).toBeGreaterThan(0);
      expect(names.some((n) => normalizeCity(n) === c), `${c} does not place itself`).toBe(true);
    }
  });

  it("no place is served by two warehouses", () => {
    // A city in two catchments would resolve by object key order — that is, by
    // accident — and its movements would be reconciled against the wrong gate.
    const seen = new Map<string, string>();
    for (const c of CITIES) {
      for (const n of catchmentFor(c)) {
        expect(seen.has(n), `${n} is claimed by both ${seen.get(n)} and ${c}`).toBe(false);
        seen.set(n, c);
      }
    }
  });
});
