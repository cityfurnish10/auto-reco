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
