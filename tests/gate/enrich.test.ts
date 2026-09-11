// Enrichment must describe the UNIT, never today's plan.
//
// The gate is only worth having because it is an independent witness. Looking a
// serial up in gate_expected_items — the day's planned pickings — would make it
// agree with Odoo by construction. These tests pin the query to the lot master
// and the separation of derived columns from witnessed ones.

import { describe, expect, it } from "vitest";
import { taskForScan, taskWindowClosed, unitFactsSql, unitTaskPipeline, type UnitTask } from "../../lib/gate/enrich";

const sql = unitFactsSql(["FUL5ZA24120009", "APC7VY19041490"]);

describe("the enrichment query", () => {
  it("reads the lot master, which is identity", () => {
    expect(sql).toContain("FROM stock_lot sl");
    expect(sql).toContain("product_template");
  });

  it("never touches the day's planned movements", () => {
    // The whole point. gate_expected_items is what the old path used and is
    // exactly what must not appear here.
    expect(sql).not.toContain("gate_expected_items");
    expect(sql.toLowerCase()).not.toContain("expected");
  });

  it("only considers COMPLETED movements for the last-known context", () => {
    // A pending or planned picking would smuggle the plan back in through the
    // history join.
    expect(sql).toContain("sml.state = 'done'");
  });

  it("takes the most recent movement per serial, and survives a unit that never moved", () => {
    expect(sql).toContain("DISTINCT ON (sl.name)");
    expect(sql).toContain("ORDER BY sl.name, sml.date DESC NULLS LAST");
    // LEFT JOIN, so a brand-new unit still returns its product.
    expect(sql).toContain("LEFT JOIN stock_move_line");
  });

  it("asks only about the serials it was given", () => {
    expect(sql).toContain("'FUL5ZA24120009'");
    expect(sql).toContain("'APC7VY19041490'");
  });
});

describe("what the query cannot be made to do", () => {
  // A barcode comes from a QR code a guard pointed a camera at, so its contents
  // are chosen by whoever printed the sticker. Metabase native SQL has no bind
  // parameters, so the builder itself refuses anything that could not be a lot
  // name — safe by construction, not safe-if-called-through-the-wrapper.
  it("drops anything that could not be a serial", () => {
    const dirty = unitFactsSql(["GOOD123456", "'; DROP TABLE gate_scans; --"]);
    expect(dirty).toContain("'GOOD123456'");
    expect(dirty).not.toContain("DROP TABLE");
    expect(dirty).not.toContain("--");
  });

  it("returns an empty string when nothing is askable, so no query is run", () => {
    expect(unitFactsSql(["'; DROP TABLE x; --"])).toBe("");
    expect(unitFactsSql([])).toBe("");
  });

  it("deduplicates, so one truck of identical products is one lookup", () => {
    const s2 = unitFactsSql(["AAA111111", "AAA111111", " AAA111111 "]);
    expect(s2.match(/'AAA111111'/g)).toHaveLength(1);
  });
});

describe("the DT task lookup (ticket, job type, customer)", () => {
  const pipe = JSON.stringify(unitTaskPipeline(["FUL5ZA24120009", "FUL5ZA24120009", "'; DROP x"]));

  it("asks only about plausible serials, once each", () => {
    expect(pipe.match(/FUL5ZA24120009/g)).toHaveLength(1);
    expect(pipe).not.toContain("DROP");
    expect(unitTaskPipeline(["'; DROP x"])).toBeNull();
  });

  it("returns every task with its date, so each scan can be matched to its own", () => {
    // The first version kept only the newest task per unit, which is how a
    // March pickup ended up on a September scan.
    expect(pipe).not.toContain('"$first"');
    expect(pipe).toContain('"scheduled":"$dv.scheduledDate"');
    expect(pipe).toContain('"$pickup_deliveryId"');
  });

  it("cannot lose the batch to one malformed task id", () => {
    expect(pipe).toContain('"onError":null');
    expect(pipe).not.toContain("$toObjectId");
  });
});

describe("matching a DT task to the scan it explains", () => {
  const task = (kind: "pickup" | "delivery", date: string, ticket: string): UnitTask => ({
    serial: "S", kind, date, ticket, jobType: null, customer: null, so: null, city: null,
  });

  it("THE REPORTED CASE: a six-month-old pickup is not today's movement", () => {
    // FUL5ZA24120009's real DT history, and its real gate scan: inward at
    // Delhi, 11 Sep 2026 15:20 IST. The screen showed ticket 1099165.
    const history = [task("pickup", "2026-03-08", "1099165"), task("delivery", "2025-09-07", "938667")];
    expect(taskForScan(history, "2026-09-11T09:50:30.622Z", "IN")).toBeNull();
  });

  it("attaches a delivery scheduled today to an outward scan", () => {
    const t = taskForScan([task("delivery", "2026-09-12", "D1")], "2026-09-12T03:00:00Z", "OUT");
    expect(t?.ticket).toBe("D1");
  });

  it("allows a truck loaded the evening before its delivery day", () => {
    // 20:00 IST on the 11th, delivery scheduled for the 12th.
    expect(taskForScan([task("delivery", "2026-09-12", "D1")], "2026-09-11T14:30:00Z", "OUT")?.ticket).toBe("D1");
    expect(taskForScan([task("delivery", "2026-09-13", "D2")], "2026-09-11T14:30:00Z", "OUT")).toBeNull();
  });

  it("allows a pickup that reaches the gate a few days later, and no later", () => {
    const scan = "2026-09-12T06:00:00Z"; // 12 Sep IST
    expect(taskForScan([task("pickup", "2026-09-09", "P1")], scan, "IN")?.ticket).toBe("P1");
    expect(taskForScan([task("pickup", "2026-09-08", "P0")], scan, "IN")).toBeNull();
  });

  it("prefers the kind that matches the direction, then the nearest date", () => {
    const scan = "2026-09-12T06:00:00Z";
    const both = [task("delivery", "2026-09-12", "D"), task("pickup", "2026-09-11", "P")];
    expect(taskForScan(both, scan, "IN")?.ticket).toBe("P");
    expect(taskForScan(both, scan, "OUT")?.ticket).toBe("D");
    const two = [task("pickup", "2026-09-09", "far"), task("pickup", "2026-09-12", "near")];
    expect(taskForScan(two, scan, "IN")?.ticket).toBe("near");
  });

  it("still explains a failed delivery coming back in the same day", () => {
    expect(taskForScan([task("delivery", "2026-09-12", "D")], "2026-09-12T12:00:00Z", "IN")?.ticket).toBe("D");
  });

  it("keeps asking while a task could still be entered, then stops", () => {
    const scan = "2026-09-11T09:50:30Z";
    expect(taskWindowClosed(scan, new Date("2026-09-12T10:00:00Z"))).toBe(false);
    expect(taskWindowClosed(scan, new Date("2026-09-14T10:00:00Z"))).toBe(true);
  });
});

describe("where the looked-up details are allowed to go", () => {
  it("the reconciliation's gate reader never selects them", async () => {
    const { readFileSync } = await import("node:fs");
    const guard = readFileSync("lib/connectors/guard.ts", "utf8");
    for (const col of ["unit_product", "last_customer", "last_so", "task_ticket", "task_job_type", "task_customer", "task_so"]) {
      expect(guard).not.toContain(col);
    }
  });

  it("the guard's own history never selects them", async () => {
    const { readFileSync } = await import("node:fs");
    const hist = readFileSync("app/api/gate/history/route.ts", "utf8");
    expect(hist).not.toMatch(/task_|unit_product|last_customer|select\(\s*"\*"/);
  });
});
