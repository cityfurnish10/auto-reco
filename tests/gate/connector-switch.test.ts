// The switch is the riskiest single line in the rollout: it decides which
// record the nightly reconciliation believes about physical movement. These
// pin the two behaviours that would be expensive to get wrong.

import { describe, expect, it, afterEach } from "vitest";
import { gateAppCities } from "../../lib/connectors/guard";

const orig = process.env.GATE_APP_CITIES;
afterEach(() => { process.env.GATE_APP_CITIES = orig; });

describe("gateAppCities", () => {
  it("is empty by default — every city stays on paper until told otherwise", () => {
    delete process.env.GATE_APP_CITIES;
    expect(gateAppCities().size).toBe(0);
  });

  it("reads a single pilot city", () => {
    process.env.GATE_APP_CITIES = "DELHI";
    expect([...gateAppCities()]).toEqual(["DELHI"]);
  });

  it("tolerates spacing and case, because this gets typed into a dashboard", () => {
    process.env.GATE_APP_CITIES = " delhi , Mumbai ";
    expect([...gateAppCities()].sort()).toEqual(["DELHI", "MUMBAI"]);
  });

  it("ignores a city that does not exist rather than inventing one", () => {
    // A typo must not silently create a sixth city that matches no rows and
    // quietly leaves a real city on the wrong source.
    process.env.GATE_APP_CITIES = "DELHI,DEHLI";
    expect([...gateAppCities()]).toEqual(["DELHI"]);
  });
});

// ── A quiet gate versus a dead phone ─────────────────────────────────────
//
// THE MOST DANGEROUS CHANGE IN THIS FEATURE, stated plainly: this is the only
// place that can turn an absent source into a CONFIDENT ZERO. Get it wrong in
// one direction and a broken phone reads as "nothing moved", which invents an
// empty day and hides every unit that actually left. Get it wrong in the other
// and a genuinely quiet gate is recorded as a failure — which is what happened
// before, and is merely annoying.
//
// So the asymmetry below is deliberate: silence defaults to "the source is
// down", and only an explicit assertion by somebody who was there — already
// checked against their own scans at sync time — moves it.

import { vi } from "vitest";

// The connector builds its own client, so the module is mocked rather than the
// client injected. Each test sets what the two tables return.
const tables: { scans: unknown[]; quiet: unknown[] } = { scans: [], quiet: [] };

vi.mock("../../lib/supabase/admin", () => {
  const chain = (rows: unknown[]) => {
    const self: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "limit"]) self[m] = () => self;
    (self as { then: unknown }).then = (res: (v: unknown) => void) =>
      res({ data: rows, error: null });
    return self;
  };
  return {
    createAdminClient: () => ({
      from(table: string) {
        if (table === "gate_scans") return chain(tables.scans);
        if (table === "guard_shifts") return chain(tables.quiet);
        return chain([]);                    // guard_uploads — the paper cities
      },
    }),
  };
});

const { guardConnector } = await import("../../lib/connectors/guard");

function ctx() {
  const warns: string[] = [];
  const incomplete: string[] = [];
  return {
    warns, incomplete,
    ctx: { warn: (m: string) => warns.push(m), incomplete: (c: string) => incomplete.push(c) },
  };
}

describe("a city on the app that recorded nothing", () => {
  const origEnv = process.env.GATE_APP_CITIES;
  afterEach(() => {
    process.env.GATE_APP_CITIES = origEnv;
    tables.scans = []; tables.quiet = [];
  });

  it("is treated as a FAILED SOURCE by default", async () => {
    // The safe reading of silence: an unmanned shift, or a phone that never
    // synced. Marking it incomplete demotes the gate for that day rather than
    // letting an outage look like an empty warehouse.
    process.env.GATE_APP_CITIES = "DELHI";
    const c = ctx();
    await guardConnector.pull("2026-08-25", c.ctx as never);
    expect(c.incomplete).toContain("DELHI");
  });

  it("is a REAL ZERO when a guard asserted the gate was quiet", async () => {
    process.env.GATE_APP_CITIES = "DELHI";
    tables.quiet = [{ city: "DELHI" }];
    const c = ctx();
    await guardConnector.pull("2026-08-25", c.ctx as never);
    expect(c.incomplete).not.toContain("DELHI");
    expect(c.warns.join(" ")).toMatch(/quiet day/i);
  });

  it("does not let one city's quiet day vouch for another's silence", async () => {
    // The failure that would be easy to write and impossible to spot: a single
    // boolean instead of a per-city set, and Mumbai's dead phone rides in on
    // Delhi's quiet afternoon.
    process.env.GATE_APP_CITIES = "DELHI,MUMBAI";
    tables.quiet = [{ city: "DELHI" }];
    const c = ctx();
    await guardConnector.pull("2026-08-25", c.ctx as never);
    expect(c.incomplete).toEqual(["MUMBAI"]);
  });

  it("says nothing about a city that actually recorded scans", async () => {
    process.env.GATE_APP_CITIES = "DELHI";
    tables.scans = [{ city: "DELHI", direction: "OUT", barcode: "FUL5ZA24120009",
                      item_kind: "unit", quantity: 1, entry_method: "scan",
                      scanned_at: "2026-08-25T10:00:00Z" }];
    const c = ctx();
    const rows = await guardConnector.pull("2026-08-25", c.ctx as never);
    expect(rows).toHaveLength(1);
    expect(c.incomplete).toEqual([]);
  });
});
