// The engine judges a closed warehouse from the delivery app's own calendar.
//
// Until 25 Sep 2026 it read the hardcoded weekly map while the dashboards and
// Odoo's window read the synced calendar, so the two disagreed about the same
// Thursday: the calendar had Delhi shut, the map had it working. Policy and
// practice differ as well — the rule is Thursday off everywhere but Bangalore,
// and on 24 Sep 2026 Mumbai and Pune worked theirs — so what the calendar
// records is what the engine now believes.

import { describe, it, expect } from "vitest";
import { runReconciliation } from "../../lib/engine/run";
import type { SourceRow } from "../../lib/engine/types";
import type { ClosureCalendar } from "../../lib/engine/schedule";

const THU = "2026-09-24";
const odooOnly = (barcode: string): SourceRow => ({
  source: "ODOO", direction: "OUT", barcode, status: "done", date: THU,
  createdOn: THU, soNumber: "ON-RET-GUR-90001",
});

/** The run's warnings say which way the day was read. */
const offDayNoted = (warnings: string[]) =>
  warnings.some((w) => /weekly off|closed|off day/i.test(w));

describe("the engine reads the synced calendar", () => {
  const rows = [odooOnly("FUMYGB22120061")];

  it("treats Delhi's Thursday as shut when the calendar says so", () => {
    const cal: ClosureCalendar = { weeklyOff: { DELHI: [4] }, holidays: {} };
    const res = runReconciliation(rows, "DELHI", undefined, new Set(), THU, new Set(), new Set(), cal);
    // The Odoo-only same-day accusation cannot stand on a day nothing could move.
    expect(res.variances.filter((v) => v.priority === "High")).toHaveLength(0);
  });

  it("treats Mumbai's Thursday as worked when the calendar says it worked", () => {
    // Policy says Mumbai is off; the app's calendar records that it was not.
    const cal: ClosureCalendar = { weeklyOff: { DELHI: [4] }, holidays: {} };
    const res = runReconciliation(
      [{ ...rows[0], soNumber: "ON-RET-MUM-90001" }],
      "MUMBAI", undefined, new Set(), THU, new Set(), new Set(), cal
    );
    expect(offDayNoted(res.warnings)).toBe(false);
  });

  it("falls back to the literal map when no calendar is supplied", () => {
    // Mumbai is Thursday-off in the literal map, so the same day reads shut.
    const res = runReconciliation(
      [{ ...rows[0], soNumber: "ON-RET-MUM-90001" }], "MUMBAI", undefined, new Set(), THU
    );
    expect(res.variances.filter((v) => v.priority === "High")).toHaveLength(0);
  });

  it("honours a one-off holiday from the calendar", () => {
    const cal: ClosureCalendar = { weeklyOff: {}, holidays: { BANGALORE: [THU] } };
    const res = runReconciliation(
      [{ ...rows[0], soNumber: "ON-RET-BAN-90001" }],
      "BANGALORE", undefined, new Set(), THU, new Set(), new Set(), cal
    );
    expect(res.variances.filter((v) => v.priority === "High")).toHaveLength(0);
  });
});
