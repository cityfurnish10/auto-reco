// What would the trip form actually offer a guard RIGHT NOW?
//
// This one talks to the live Delivery Tracker, so it is skipped unless asked
// for explicitly:
//
//   LIVE_DT=1 npx vitest run tests/live/fleet.live.test.ts
//
// It exists because "the code compiles" and "a guard at Gurgaon would see their
// truck in the list" are different claims, and only the second one matters.
// Every other test here mocks the network; this is the one that does not, which
// is exactly why it must never run in the normal suite.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fleetForCity } from "../../lib/gate/fleet";
import { CITIES } from "../../lib/sample-data";

// vitest does not load .env.local, and a run that silently finds no
// credentials returns an empty fleet in 0ms — which looks exactly like "DT has
// nothing scheduled". Load it here so the two cannot be confused.
try {
  for (const l of readFileSync(".env.local", "utf8").split("\n")) {
    const m = l.match(/^\s*([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
  }
} catch { /* not present — the guard below reports it */ }

const live = process.env.LIVE_DT === "1";

describe.skipIf(!live)("the fleet, read live from the Delivery Tracker", () => {
  it("has credentials at all", () => {
    // Asserted separately, because an unconfigured run and an empty day look
    // identical downstream and only one of them is a problem with the query.
    expect(process.env.METABASE_URL, "METABASE_URL missing from .env.local").toBeTruthy();
    expect(process.env.METABASE_API_KEY, "METABASE_API_KEY missing from .env.local").toBeTruthy();
  });

  it("offers real trucks and agents for at least one city", async () => {
    const found: Record<string, { trucks: number; agents: number; ms: number }> = {};
    let anyVehicles = 0;

    for (const city of CITIES) {
      const t0 = Date.now();
      const f = await fleetForCity(city);
      found[city] = { trucks: f.vehicles.length, agents: f.agents.length, ms: Date.now() - t0 };
      anyVehicles += f.vehicles.length;
      if (f.vehicles.length) {
        console.log(`  ${city}: ${f.vehicles.slice(0, 5).join(", ")}`);
        console.log(`     agents: ${f.agents.slice(0, 5).join(", ")}`);
        // Every registration that reaches a dropdown must look like a plate. A
        // wrong-looking option is worse than a missing one — a missing one
        // sends the guard to the text box, a wrong one gets tapped.
        for (const v of f.vehicles) expect(v).toMatch(/^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$/);
      }
    }

    console.table(found);
    expect(anyVehicles, "no city returned a single truck — the query found nothing").toBeGreaterThan(0);
  }, 60_000);

  it("each truck carries its own agent and planned load", async () => {
    // The shape that matters: a guard picks the vehicle in front of them and
    // the agent and the units follow, rather than picking both from two flat
    // city-wide lists that say nothing about each other.
    for (const city of CITIES) {
      const f = await fleetForCity(city);
      if (!f.trips.length) continue;
      console.log(`\n  ${city}`);
      for (const t of f.trips.slice(0, 3)) {
        console.log(`    ${t.vehicle}  ${t.agents.join(", ") || "(no agent)"}  ` +
                    `${t.tasks.length} task(s), ${t.unitCount} unit(s)`);
        for (const k of t.tasks.slice(0, 2)) {
          console.log(`       ${k.jobType ?? "—"} · ${k.customer ?? "—"} · ${k.ticket ?? "—"}`);
          console.log(`       ${k.address ?? "(no address)"}`);
          for (const u of k.units.slice(0, 3)) console.log(`         ${u.barcode}  ${u.product ?? ""}`);
        }
      }
      for (const t of f.trips) {
        expect(t.vehicle).toMatch(/^[A-Z]{2}\d{1,2}[A-Z0-9]{0,4}\d{4}$/);
        // Every vehicle offered must appear in the flat list the picker uses.
        expect(f.vehicles).toContain(t.vehicle);
        // unitCount may legitimately be ZERO — see below.
        expect(t.unitCount).toBeGreaterThanOrEqual(0);
        expect(t.unitCount).toBe(t.tasks.reduce((n, k) => n + k.units.length, 0));
      }

      // A TRUCK WITH NOTHING PLANNED IS STILL OFFERED, and that is deliberate.
      // It is physically at the gate; its units may all be marked done already,
      // or it may be running an ad-hoc trip. Hiding it would send a guard to
      // manual entry for a vehicle DT knows about, which is the exact friction
      // the list exists to remove. It simply shows nothing when selected.
      const loaded = f.trips.filter((t) => t.unitCount > 0);
      const empty = f.trips.filter((t) => t.unitCount === 0);
      console.log(`    ${loaded.length} truck(s) with a planned load, ${empty.length} without`);

      // Most-loaded first, so the truck a guard is most likely looking at is
      // nearest the top of the list.
      const counts = f.trips.map((t) => t.unitCount);
      expect(counts, "trips are not sorted by load").toEqual([...counts].sort((a, b) => b - a));
    }
  }, 60_000);
});
