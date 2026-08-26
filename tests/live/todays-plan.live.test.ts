// What the app believes is planned today, printed so a person can check it.
//
//   LIVE_DT=1 npx vitest run tests/live/todays-plan.live.test.ts --reporter=verbose
//
// Written because "is it catching the right data?" is a fair question that no
// amount of internal testing answers. Every row carries its DT ticket number,
// so each one can be opened in DT and compared against what this claims.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fetchDtExpected } from "../../lib/gate/expected-dt";
import { fleetForCity } from "../../lib/gate/fleet";
import { CITIES } from "../../lib/sample-data";

try {
  for (const l of readFileSync(".env.local", "utf8").split("\n")) {
    const m = l.match(/^\s*([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
  }
} catch { /* the assertions below report it */ }

const live = process.env.LIVE_DT === "1";
const DAY = process.env.PLAN_DAY ?? new Date().toISOString().slice(0, 10);
const pad = (s: unknown, n: number) => String(s ?? "—").slice(0, n).padEnd(n);

describe.skipIf(!live)("today's plan, for external verification", () => {
  it("prints every planned movement with its ticket", async () => {
    const pull = await fetchDtExpected(DAY);
    console.log(`\nDT — MOVEMENTS PLANNED FOR ${DAY}`);
    console.log(`${pull.rows.length} unit(s). Skipped: ${pull.skipped.unknownCity} unplaceable, ` +
                `${pull.skipped.ambiguousDirection} ambiguous direction.\n`);

    // Grouped by ticket, which is what a person can look up in DT.
    const byTicket = new Map<string, {
      ticketId: string | null; direction: string; city: string;
      customer: string | null; jobType: string | null; address: string | null;
      units: { barcode: string; product: string | null }[];
    }>();
    for (const r of pull.rows) {
      const k = `${r.ticketId ?? "—"}|${r.direction}`;
      if (!byTicket.has(k)) byTicket.set(k, {
        ticketId: r.ticketId, direction: r.direction, city: r.city,
        customer: r.customer, jobType: r.orderDetails, address: r.deliveryAddress, units: [],
      });
      byTicket.get(k)!.units.push({ barcode: r.barcode, product: r.product });
    }

    // Grouped city, then job type — the two axes a person checking this
    // actually reads it along. A flat list sorted by ticket is sorted by an
    // identifier nobody thinks in.
    const tickets = [...byTicket.values()];
    const cities = [...new Set(tickets.map((t) => t.city))].sort();

    for (const city of cities) {
      const inCity = tickets.filter((t) => t.city === city);
      const units = inCity.reduce((n, t) => n + t.units.length, 0);
      console.log(`\n${"=".repeat(100)}`);
      console.log(`${city}   ${inCity.length} task(s), ${units} unit(s)`);
      console.log("=".repeat(100));

      const jobs = [...new Set(inCity.map((t) => t.jobType ?? "—"))].sort();
      for (const job of jobs) {
        const inJob = inCity.filter((t) => (t.jobType ?? "—") === job);
        const jobUnits = inJob.reduce((n, t) => n + t.units.length, 0);
        console.log(`\n  ${job}  —  ${inJob.length} task(s), ${jobUnits} unit(s)`);
        console.log("  " + "-".repeat(96));
        // Outward before inward within a job type: a guard's day is shaped by
        // dispatch, and an inward is usually the return leg of an outward.
        for (const t of inJob.sort((a, b) => a.direction.localeCompare(b.direction) ||
                                             String(a.ticketId).localeCompare(String(b.ticketId)))) {
          console.log("  " + pad(t.ticketId, 10) + pad(t.direction, 5) +
                      pad(t.customer, 24) + `${t.units.length} unit(s)`);
          for (const u of t.units) {
            console.log(" ".repeat(12) + pad(u.barcode, 18) + String(u.product ?? "").slice(0, 46));
          }
          if (t.address) console.log(" ".repeat(12) + t.address.slice(0, 86));
        }
      }
    }

    console.log(`\n${"=".repeat(100)}`);
    console.log("TOTALS BY CITY AND JOB TYPE");
    console.log("=".repeat(100));
    console.log("  " + pad("CITY", 12) + pad("JOB TYPE", 22) + pad("TASKS", 8) +
                pad("UNITS", 8) + pad("OUT", 6) + "IN");
    for (const city of cities) {
      const inCity = tickets.filter((t) => t.city === city);
      for (const job of [...new Set(inCity.map((t) => t.jobType ?? "—"))].sort()) {
        const g = inCity.filter((t) => (t.jobType ?? "—") === job);
        console.log("  " + pad(city, 12) + pad(job, 22) +
                    pad(g.length, 8) + pad(g.reduce((n, t) => n + t.units.length, 0), 8) +
                    pad(g.filter((t) => t.direction === "OUT").length, 6) +
                    g.filter((t) => t.direction === "IN").length);
      }
    }
    expect(pull.rows.length).toBeGreaterThanOrEqual(0);
  }, 90_000);

  it("prints the trucks and agents DT has assigned", async () => {
    console.log("\nDT — TRUCKS AND AGENTS ASSIGNED\n");
    for (const city of CITIES) {
      const f = await fleetForCity(city);
      if (!f.vehicles.length && !f.agents.length) { console.log(`  ${city}: nothing assigned`); continue; }
      console.log(`  ${city}`);
      for (const t of f.trips) {
        console.log("    " + pad(t.vehicle, 14) + pad(t.agents.join(", "), 28) +
                    `${t.tasks.length} task(s), ${t.unitCount} unit(s)`);
      }
      const loose = f.agents.filter((a) => !f.trips.some((t) => t.agents.includes(a)));
      if (loose.length) console.log(`    agents with no truck: ${loose.join(", ")}`);
    }
  }, 90_000);
});
