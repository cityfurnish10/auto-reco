// Is this date settled enough to judge? A warehouse day runs 15:00 → 15:00.
import { describe, expect, it } from "vitest";
import { runDateFreshness } from "../../lib/reconcile/cron-dates";

// 15 Sep 2026, 12:45 IST — the moment a mid-day run of 14 Sep was read as a
// clean day. 14 Sep runs until 15:00 that afternoon.
const midday = new Date("2026-09-15T07:15:00Z");

describe("running a date by hand", () => {
  it("THE REPORTED CASE: 14 Sep at 12:45 on the 15th is still open", () => {
    expect(runDateFreshness("2026-09-14", midday)).toBe("open");
  });

  it("the most recently closed day is fresh — Odoo is still posting into it", () => {
    // At 12:45 on the 15th the last closed day is the 13th (shut at 15:00 on
    // the 14th); after 15:00 on the 15th it is the 14th.
    expect(runDateFreshness("2026-09-13", midday)).toBe("fresh");
    expect(runDateFreshness("2026-09-14", new Date("2026-09-15T10:30:00Z"))).toBe("fresh");
  });

  it("the date the scheduled run targets needs no warning — it waits a day longer", () => {
    expect(runDateFreshness("2026-09-12", midday)).toBeNull();
  });

  it("a future date is open, never settled", () => {
    expect(runDateFreshness("2026-09-20", midday)).toBe("open");
  });
});
