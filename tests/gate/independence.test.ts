// THE GUARD IS NEVER SHOWN WHAT IS EXPECTED.
//
// This is the design constraint the whole project rests on, and it has been
// broken three times by me — as a trip-close "still on the plan" panel, as an
// against-the-plan tally, and as a "planned on this vehicle" list on the trip
// form. Each time it looked like a helpful feature. Each time it quietly
// destroyed the thing being built.
//
// WHY IT MATTERS, stated once so it does not have to be re-argued:
//
//   The reconciliation compares four sources — Odoo, DT, the warehouse sheet,
//   and the gate. The gate is worth having because it is INDEPENDENT: it is
//   the only one where a person physically saw the item cross the threshold.
//
//   Show a guard the list of what should be on the truck and they will scan
//   against the list. The gate record stops being "what I saw" and becomes
//   "what the systems told me to expect, confirmed". Four sources become
//   three, and the witness that was meant to catch the other three now agrees
//   with them by construction. The discrepancy that mattered is gone, and
//   nobody can tell, because everything now matches.
//
// The check still runs and is still recorded. A MANAGER reads it in the
// portal, after the fact, which is where a discrepancy belongs. Nothing about
// it reaches the phone.
//
// So this test reads the guard app's source and fails if expectation data has
// found its way back into it. It is deliberately blunt.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { COMPLETENESS_SHOWN, EXPECTED_CHECK_LIVE } from "../../lib/gate/config";

const APP = readFileSync("app/(gate)/scan/scan-app.tsx", "utf8");

/** Only the JSX, so computing a value is fine and RENDERING it is not. */
const RENDER = APP.slice(APP.indexOf("/* ── render ──"));

describe("the gate stays an independent witness", () => {
  it("never shows the guard what the plan expects", () => {
    // Each of these rendered at some point and each had to be taken back out.
    const forbidden = [
      "plannedOnThis",     // "Planned on this vehicle" — the truck's load
      "stillMissing",      // "Still on the plan" — the close-screen panel
      "againstPlan",       // the scanned-against-planned tally
      "missingWhy",
    ];
    const present = forbidden.filter((k) => RENDER.includes(`t("${k}")`));
    expect(present, `the guard app renders expectation data: ${present.join(", ")}`).toEqual([]);
  });

  it("does not render the planned units DT attaches to a truck", () => {
    // fleet.trips carries each truck's planned load. It is fine to FETCH — the
    // vehicle list is built from it — and not fine to draw.
    expect(RENDER).not.toMatch(/\.tasks\b/);
    expect(RENDER).not.toMatch(/plannedForVehicle/);
    expect(RENDER).not.toMatch(/unitCount/);
  });

  it("does not fill the agent in from the truck", () => {
    // DT knows who is supposed to be driving. Telling the guard would be the
    // app asserting a fact the guard is standing there to establish.
    expect(APP).not.toMatch(/setDrv\(\s*only\s*\)/);
    expect(APP).not.toMatch(/agents\.length === 1/);
  });

  it("keeps both expectation switches off", () => {
    // They exist so the intent is written down rather than merely absent.
    expect(COMPLETENESS_SHOWN, "the close screen would show the plan").toBe(false);
    expect(EXPECTED_CHECK_LIVE, "a scan would be interrupted with 'not on the list'").toBe(false);
  });

  it("still RECORDS the check, because a manager has to read it", () => {
    // Independence means the guard is not shown it — not that it is not
    // measured. Removing the measurement would be the opposite mistake.
    expect(APP).toMatch(/completeness/);
    expect(APP).toMatch(/expectedTotal/);
  });
});
