import { describe, expect, it } from "vitest";
import { runReconciliation } from "../../lib/engine/run";
import type { SourceRow } from "../../lib/engine/types";

const RUN = "2026-08-04";

const r = (
  p: Partial<SourceRow> & Pick<SourceRow, "source" | "direction" | "barcode">
): SourceRow => ({ date: RUN, ...p }) as SourceRow;

/** A clean unit, so run-date derivation has an anchor and never throws. */
const anchor = (): SourceRow[] => [
  r({ source: "PHYSICAL", direction: "OUT", barcode: "ANCHOR0000001", status: "done" }),
  r({ source: "SHEET", direction: "OUT", barcode: "ANCHOR0000001", status: "done" }),
  r({ source: "DT", direction: "OUT", barcode: "ANCHOR0000001", status: "done" }),
  r({ source: "ODOO", direction: "OUT", barcode: "ANCHOR0000001", status: "done", createdOn: RUN }),
];

const run = (rows: SourceRow[]) =>
  runReconciliation([...anchor(), ...rows], "DELHI", undefined, new Set(), RUN);

const namesFor = (rows: SourceRow[], barcode: string) =>
  run(rows)
    .variances.filter((v) => v.barcode === barcode)
    .map((v) => `${v.direction} ${v.variance_name}`);

describe("the return leg of a failed delivery", () => {
  // The reported case, 2026-08-04: APC7VY26070183 went out as "New - Rental",
  // came back "Not Delivered", and ops wrote the return inward as "Received".
  // Odoo still holds the unit In Transit — there is no inward posting to find —
  // so the ladder raised "Ops Sheet Only" REAL against a return that behaved
  // exactly as a failed delivery should.
  const FAILED = [
    r({ source: "SHEET", direction: "OUT", barcode: "APC7VY26070183", status: "Not Delivered", jobType: "New - Rental" }),
    r({ source: "SHEET", direction: "IN", barcode: "APC7VY26070183", status: "Received", jobType: "New - Rental" }),
  ];

  it("raises nothing for either leg", () => {
    expect(namesFor(FAILED, "APC7VY26070183")).toEqual([]);
  });

  it("keeps the RETURN as a movement, and records why it was suppressed", () => {
    // The unit physically came back, so the return is a real movement and the
    // four-way check must keep seeing it — suppressed withholds the accusation,
    // not the row. The ledger records the reason so the day can be audited.
    const ev = run(FAILED).movement_events.filter((e) => e.barcode === "APC7VY26070183");
    const inward = ev.find((e) => e.direction === "IN");
    expect(inward).toBeDefined();
    expect(inward?.suppressedReason).toBe("failed_delivery_return");
    expect(inward?.isMovement).toBe(true);
  });

  it("does not count the FAILED OUTWARD as a movement at all", () => {
    // Separate from the suppression, and older than it: done-tasks-only drops a
    // not-done unit before the views are built. A delivery that did not happen
    // is not a movement, so it must not inflate the day's outward count.
    const ev = run(FAILED).movement_events.filter((e) => e.barcode === "APC7VY26070183");
    expect(ev.map((e) => e.direction)).toEqual(["IN"]);
  });

  it("says so in the run's warnings, so it is auditable", () => {
    expect(run(FAILED).warnings.join(" ")).toMatch(/return of a failed delivery/i);
  });

  // ── the boundaries ────────────────────────────────────────────────────────

  it("does NOT suppress an inward when the outward succeeded", () => {
    // Same unit in and out on one day is a real shape — a replacement. It must
    // keep grading normally.
    const names = namesFor(
      [
        r({ source: "SHEET", direction: "OUT", barcode: "FUW11V19060738", status: "Delivered" }),
        r({ source: "SHEET", direction: "IN", barcode: "FUW11V19060738", status: "Received" }),
      ],
      "FUW11V19060738"
    );
    expect(names.length).toBeGreaterThan(0);
  });

  it("does NOT suppress when ANY source says the outward completed", () => {
    // done-wins already decides this upstream: one book saying delivered means
    // the unit went out, whatever the ops sheet typed.
    const names = namesFor(
      [
        r({ source: "SHEET", direction: "OUT", barcode: "FUM24018110500", status: "Not Delivered" }),
        r({ source: "DT", direction: "OUT", barcode: "FUM24018110500", status: "done" }),
        r({ source: "SHEET", direction: "IN", barcode: "FUM24018110500", status: "Received" }),
      ],
      "FUM24018110500"
    );
    expect(names.length).toBeGreaterThan(0);
  });

  it("does NOT invert — a failed INWARD leaves the outward alone", () => {
    // A pickup that did not happen means nothing arrived; there is no outward
    // leg it could excuse. Inverting the rule would silence real dispatches.
    const names = namesFor(
      [
        r({ source: "SHEET", direction: "IN", barcode: "0T2JR222120042", status: "Not Received" }),
        r({ source: "SHEET", direction: "OUT", barcode: "0T2JR222120042", status: "Delivered" }),
      ],
      "0T2JR222120042"
    );
    expect(names.some((n) => n.startsWith("OUT"))).toBe(true);
  });

  it("leaves an unrelated inward on the same day untouched", () => {
    const rows = [
      ...[
        r({ source: "SHEET", direction: "OUT", barcode: "APC7VY26070183", status: "Not Delivered" }),
        r({ source: "SHEET", direction: "IN", barcode: "APC7VY26070183", status: "Received" }),
      ],
      r({ source: "SHEET", direction: "IN", barcode: "AP815723030038", status: "Received" }),
    ];
    expect(namesFor(rows, "APC7VY26070183")).toEqual([]);
    expect(namesFor(rows, "AP815723030038").length).toBeGreaterThan(0);
  });
});
