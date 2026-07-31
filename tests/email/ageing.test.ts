import { describe, expect, it } from "vitest";
import { summariseAgeing, daysBetween, type AgeingRow } from "../../lib/email/digest/ageing";
import { VARIANCE } from "../../lib/engine/variance-names";

const REPORT = "2026-07-30";
// All seven prior days re-checked, which is the state the pg_cron sweep leaves.
const FRESH = new Set([
  "2026-07-23",
  "2026-07-24",
  "2026-07-25",
  "2026-07-26",
  "2026-07-27",
  "2026-07-28",
  "2026-07-29",
]);

const row = (over: Partial<AgeingRow> = {}): AgeingRow => ({
  city: "DELHI",
  direction: "OUT",
  barcode: "B1",
  variance_name: VARIANCE.GATE_ONLY, // tier 1, "Off-System Movement"
  job_type: null,
  bucket: "REAL",
  note: null,
  status: "open",
  business_date: "2026-07-27",
  ...over,
});

describe("daysBetween", () => {
  it("counts whole days and survives a month boundary", () => {
    expect(daysBetween("2026-07-28", "2026-07-30")).toBe(2);
    expect(daysBetween("2026-06-30", "2026-07-02")).toBe(2);
    expect(daysBetween("2026-07-30", "2026-07-30")).toBe(0);
  });
});

describe("summariseAgeing — the age rule", () => {
  it("includes an item exactly two days old and excludes a one-day-old one", () => {
    // "not closed within 2 days" is inclusive at 2: the item was reported in the
    // digest two mornings ago and has had both days to be dealt with.
    const two = summariseAgeing([row({ business_date: "2026-07-28" })], REPORT, FRESH);
    expect(two.total).toBe(1);

    const one = summariseAgeing([row({ business_date: "2026-07-29" })], REPORT, FRESH);
    expect(one.total).toBe(0);
  });

  it("reports the age of the OLDEST day a unit appeared on", () => {
    // The same unit, still broken on three consecutive days. It is one problem,
    // three days old — not three problems.
    const rows = [
      row({ business_date: "2026-07-25" }),
      row({ business_date: "2026-07-26" }),
      row({ business_date: "2026-07-27" }),
    ];
    const s = summariseAgeing(rows, REPORT, FRESH);
    expect(s.total).toBe(1);
    expect(s.cities[0].oldestDays).toBe(daysBetween("2026-07-25", REPORT));
  });

  it("counts anything over a week separately", () => {
    const s = summariseAgeing(
      [row({ business_date: "2026-07-23", barcode: "OLD" }), row({ business_date: "2026-07-28" })],
      REPORT,
      FRESH
    );
    expect(s.total).toBe(2);
    expect(s.overAWeek).toBe(0); // 7 days is not "older than a week"
  });
});

describe("summariseAgeing — one unit, one entry", () => {
  it("counts a unit once when it raises two different variances", () => {
    // THE defect this guards: a unit carrying two rows is one piece of stock.
    // Counting rows reports churn in the paperwork as a growing pile.
    const rows = [
      row({ variance_name: VARIANCE.GATE_ONLY }),
      row({ variance_name: VARIANCE.FAILED_DELIVERY }),
    ];
    expect(summariseAgeing(rows, REPORT, FRESH).total).toBe(1);
  });

  it("separates the same barcode moving in both directions", () => {
    const rows = [row({ direction: "OUT" }), row({ direction: "IN" })];
    expect(summariseAgeing(rows, REPORT, FRESH).total).toBe(2);
  });

  it("separates the same barcode in two cities", () => {
    const rows = [row({ city: "DELHI" }), row({ city: "PUNE" })];
    expect(summariseAgeing(rows, REPORT, FRESH).total).toBe(2);
  });
});

describe("summariseAgeing — what does not belong", () => {
  it("never lists a closed item", () => {
    expect(summariseAgeing([row({ status: "closed" })], REPORT, FRESH).total).toBe(0);
  });

  it("keeps pending_approval, which an admin can still reject", () => {
    expect(summariseAgeing([row({ status: "pending_approval" })], REPORT, FRESH).total).toBe(1);
  });

  it("drops tier 3 — the engine has stopped asking for action on those", () => {
    const s = summariseAgeing([row({ variance_name: VARIANCE.ODOO_ONLY })], REPORT, FRESH);
    expect(s.total).toBe(0);
  });
});

describe("summariseAgeing — the freshness gate", () => {
  it("excludes a date nobody re-checked, and names it", () => {
    // The correctness requirement: "still open" is only true as of the last time
    // that date was reconciled. resolveStaleOpenVariances runs only on a re-run.
    const rows = [
      row({ business_date: "2026-07-27", barcode: "FRESH-1" }),
      row({ business_date: "2026-07-24", barcode: "STALE-1" }),
    ];
    const stale = new Set(["2026-07-27"]); // 24th deliberately absent
    const s = summariseAgeing(rows, REPORT, stale);
    expect(s.total).toBe(1);
    expect(s.staleDates).toEqual(["2026-07-24"]);
  });

  it("reports nothing at all when no date was re-checked", () => {
    const s = summariseAgeing([row()], REPORT, new Set());
    expect(s.total).toBe(0);
    expect(s.staleDates).toEqual(["2026-07-27"]);
  });
});

describe("summariseAgeing — the table", () => {
  it("ranks cities worst first and names the top kinds", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) =>
        row({ city: "DELHI", barcode: `D${i}`, variance_name: VARIANCE.GATE_ONLY })
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        row({ city: "DELHI", barcode: `E${i}`, variance_name: VARIANCE.FAILED_DELIVERY })
      ),
      row({ city: "PUNE", barcode: "P0" }),
    ];
    const s = summariseAgeing(rows, REPORT, FRESH);
    expect(s.cities.map((c) => c.city)).toEqual(["DELHI", "PUNE"]);
    expect(s.cities[0].items).toBe(7);
    expect(s.cities[0].kinds[0]).toEqual({ label: "Off-System Movement", count: 5 });
    expect(s.total).toBe(8);
  });

  it("collapses kinds beyond the first two into a count", () => {
    const rows = [
      row({ barcode: "A", variance_name: VARIANCE.GATE_ONLY }),
      row({ barcode: "B", variance_name: VARIANCE.FAILED_DELIVERY }),
      row({ barcode: "C", variance_name: VARIANCE.WRONG_SCAN }),
    ];
    const s = summariseAgeing(rows, REPORT, FRESH);
    expect(s.cities[0].kinds).toHaveLength(2);
    expect(s.cities[0].otherKinds).toBe(1);
  });
});
