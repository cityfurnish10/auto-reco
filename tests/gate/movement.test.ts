// The order a gate movement belongs to, decided from Odoo first.
// Every case below is a real Delhi scan from 13–14 Sep 2026.
import { describe, expect, it } from "vitest";
import { odooMoveForScan, resolveMovement, ticketForOrder, type DtOrderTask, type OdooMove } from "../../lib/gate/movement";

const move = (p: Partial<OdooMove>): OdooMove => ({
  serial: "S", date: "2026-09-14T05:00:00Z", state: "done", movementType: "In Transit",
  so: "SO-1", orderRef: null, customer: null, ...p,
});
const task = (p: Partial<DtOrderTask>): DtOrderTask => ({
  ticket: "T", jobType: "New - Rental", city: "Gurgaon", date: "2026-09-14", sos: [], orderRefs: [], ...p,
});

describe("outward: the In Transit line marked before loading", () => {
  it("THE REPORTED CASE: names today's customer, not the one who returned the unit yesterday", () => {
    // XXOTP4LT18060116, OUT 14 Sep 11:44 IST. The old DT-first match said
    // "Dishika" — its pickup on 13 Sep. Odoo's In Transit says otherwise.
    const moves = [
      move({ movementType: "Out", date: "2026-09-05T07:00:00Z", so: "ON-RET-GUR-OLD", customer: "Previous renter" }),
      move({ movementType: "In Transit", date: "2026-09-14T06:00:09Z", so: "ON-RET-GUR-81195", customer: "Akanksha Mahapatro" }),
    ];
    const r = resolveMovement(moves, [task({ ticket: "1224011", sos: ["ON-RET-GUR-81195"] })], "2026-09-14T06:14:58Z", "OUT");
    expect(r).toMatchObject({ so: "ON-RET-GUR-81195", customer: "Akanksha Mahapatro", ticket: "1224011", via: "in_transit" });
  });

  it("falls back to a reserved Out line — how the 11 without In Transit were placed", () => {
    const m = odooMoveForScan([move({ movementType: "Out", state: "assigned", date: "2026-09-14T04:57:00Z", so: "ON-RET-GUR-75341" })],
      "2026-09-14T05:31:00Z", "OUT");
    expect(m?.so).toBe("ON-RET-GUR-75341");
  });

  it("ignores a line from a different dispatch days away", () => {
    expect(odooMoveForScan([move({ date: "2026-09-10T05:00:00Z" })], "2026-09-14T05:00:00Z", "OUT")).toBeNull();
  });
});

describe("inward: the delivery that put the unit with its customer", () => {
  it("uses the last completed Out before the scan, however old", () => {
    const moves = [
      move({ movementType: "Out", date: "2025-09-07T15:00:00Z", so: "ON-RET-DEL-52343", customer: "Yuvika Agrawal" }),
      move({ movementType: "In", date: "2026-03-08T16:00:00Z", so: "ON-RET-DEL-52343" }),
      move({ movementType: "Out", state: "assigned", date: "2026-09-20T00:00:00Z", so: "FUTURE" }),
    ];
    expect(odooMoveForScan(moves, "2026-03-08T12:00:00Z", "IN")?.customer).toBe("Yuvika Agrawal");
  });
});

describe("the DT ticket for that order", () => {
  const m = move({ so: "ON-RET-GUR-81253", orderRef: "2642083232" });

  it("found through the order reference when DT holds a sibling SO", () => {
    // One order, several SOs in Odoo; DT stores one. Reference = DT orderId.
    const t = ticketForOrder([task({ ticket: "1224350", sos: ["ON-RET-GUR-81252"], orderRefs: ["2642083232"] })], m, "2026-09-14T05:30:00Z", "OUT");
    expect(t?.ticket).toBe("1224350");
  });

  it("not a job scheduled two days after the unit left", () => {
    // APMYTJ21091368: an installation on 16 Sep was picked for a 13 Sep scan.
    const t = ticketForOrder([task({ ticket: "1225338", jobType: "Installation", date: "2026-09-16", sos: ["ON-RET-GUR-81253"] })], m, "2026-09-13T05:00:00Z", "OUT");
    expect(t).toBeNull();
  });

  it("prefers a job type that fits the direction, then the nearest date", () => {
    const tasks = [
      task({ ticket: "P", jobType: "Pickup and Refund", date: "2026-09-14", sos: ["ON-RET-GUR-81253"] }),
      task({ ticket: "D-far", jobType: "New - Rental", date: "2026-09-12", sos: ["ON-RET-GUR-81253"] }),
      task({ ticket: "D-near", jobType: "New - Rental", date: "2026-09-14", sos: ["ON-RET-GUR-81253"] }),
    ];
    expect(ticketForOrder(tasks, m, "2026-09-14T05:30:00Z", "OUT")?.ticket).toBe("D-near");
    expect(ticketForOrder(tasks, m, "2026-09-14T05:30:00Z", "IN")?.ticket).toBe("P");
  });

  it("DT's own link of the barcode, once made at the doorstep, wins over the inferred ticket", () => {
    const r = resolveMovement([m], [task({ ticket: "1223078", jobType: "Repair", sos: ["ON-RET-GUR-81253"] })], "2026-09-14T05:30:00Z", "OUT",
      { ticket: "1223079", jobType: "Repair", city: "Gurgaon", date: "2026-09-14" });
    expect(r?.ticket).toBe("1223079");
    expect(r?.so).toBe("ON-RET-GUR-81253");
  });

  it("no ticket yet still gives the order and customer", () => {
    const r = resolveMovement([move({ customer: "PRANTIKA SENGAR" })], [], "2026-09-14T05:30:00Z", "OUT");
    expect(r).toMatchObject({ customer: "PRANTIKA SENGAR", ticket: null });
  });
});
