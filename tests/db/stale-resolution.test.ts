// resolveStaleOpenVariances reads ABSENCE as resolution, and that is the right
// reading for exactly one cause: a gap that closed because a late entry was
// made. Every OTHER reason the engine stops emitting a row — and there are five
// — makes the same absence mean something different.
//
// Before the suppression branch, a unit the engine deliberately silenced was
// rewritten with RESOLVED_LATE_NOTE: "this gap had cleared on the next-day
// re-check". That sentence describes an event that did not happen, and it is
// printed on the dashboard, in the digest and by the chat assistant. It already
// misfired for the three Section-7 suppressions and the failed-delivery return
// leg; the Odoo nearby-day rule would have made it the common case.

import { describe, expect, it } from "vitest";
import { resolveStaleOpenVariances } from "../../lib/db/persist";
import { RESOLVED_LATE_NOTE } from "../../lib/engine/resolution";
import type { CityRunResult, MovementEvent, VarianceRowOut } from "../../lib/engine/types";

const ALL: { P: boolean; S: boolean; D: boolean; O: boolean } = {
  P: true, S: true, D: true, O: true,
};

function event(over: Partial<MovementEvent> = {}): MovementEvent {
  return {
    barcode: "ITEM-1",
    barcode_display: "ITEM-1",
    city: "MUMBAI",
    direction: "OUT",
    date: "2026-08-01",
    present: { P: false, S: false, D: false, O: true },
    reported: ALL,
    odooSameDay: true,
    odooNextDay: false,
    odooCreatedToday: false,
    isMovement: true,
    jobType: null,
    soNumber: null,
    ticketId: null,
    customer: null,
    product: null,
    outcome: "SUPPRESSED",
    varianceNames: [],
    worstPriority: null,
    suppressedReason: "odoo_nearby_day",
    ...over,
  };
}

function variance(over: Partial<VarianceRowOut> = {}): VarianceRowOut {
  return {
    barcode: "ITEM-1",
    barcode_display: "ITEM-1",
    city: "MUMBAI",
    direction: "OUT",
    variance_name: "Odoo Posting Only — No Gate / Ops / DT Record",
    priority: "Info",
    bucket: "INFO",
    responsible: "odoo_team",
    ticket_id: null,
    so_number: null,
    customer: null,
    product: null,
    job_type: null,
    date: "2026-08-01",
    note: "n",
    present: { P: false, S: false, D: false, O: true },
    reported: ALL,
    ...over,
  };
}

const cityResult = (
  variances: VarianceRowOut[],
  movement_events: MovementEvent[]
): CityRunResult =>
  ({ city: "MUMBAI", variances, movement_events }) as unknown as CityRunResult;

interface Stored {
  id: string;
  direction: string;
  barcode: string;
  variance_name: string;
}

function stubDb(stored: Stored[]) {
  const deleted: string[][] = [];
  const updated: { patch: Record<string, unknown>; ids: string[] }[] = [];
  const db = {
    from() {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  range: (from: number, to: number) =>
                    Promise.resolve({ data: stored.slice(from, to + 1), error: null }),
                }),
              }),
            }),
          }),
        }),
        delete: () => ({
          in: (_c: string, ids: string[]) => {
            deleted.push(ids);
            return Promise.resolve({ error: null });
          },
        }),
        update: (patch: Record<string, unknown>) => ({
          in: (_c: string, ids: string[]) => {
            updated.push({ patch, ids });
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
  };
  return { db: db as never, deleted, updated };
}

const REPORTED = { MUMBAI: ALL } as never;

describe("resolveStaleOpenVariances", () => {
  it("deletes a stale row for a unit the engine SUPPRESSED, instead of calling it cleared", async () => {
    const s = stubDb([
      { id: "old", direction: "OUT", barcode: "ITEM-1", variance_name: "Odoo Posting Only — No Gate / Ops / DT Record" },
    ]);
    const res = await resolveStaleOpenVariances(
      s.db,
      "run-2",
      "2026-08-01",
      [cityResult([], [event()])],
      REPORTED
    );
    expect(s.deleted).toEqual([["old"]]);
    expect(s.updated).toHaveLength(0);
    expect(res.superseded).toBe(1);
    expect(res.resolvedLate).toBe(0);
  });

  it("still resolves-late a unit that genuinely went clean", async () => {
    // The branch this guard must not break: no variance AND no suppression, on a
    // fully covered run, is the late entry it was written for.
    const s = stubDb([
      { id: "old", direction: "OUT", barcode: "ITEM-1", variance_name: "Moved on Floor + DT — Not Posted in Odoo" },
    ]);
    const res = await resolveStaleOpenVariances(
      s.db,
      "run-2",
      "2026-08-01",
      [cityResult([], [event({ outcome: "CLEAN", suppressedReason: null })])],
      REPORTED
    );
    expect(s.deleted).toHaveLength(0);
    expect(res.resolvedLate).toBe(1);
    expect(s.updated[0].patch).toMatchObject({ note: RESOLVED_LATE_NOTE, bucket: "INFO" });
  });

  it("keys the suppression per direction, so one leg cannot settle the other", async () => {
    // The OUT leg was suppressed; the IN leg's own open row is untouched by it
    // and takes the ordinary clean-resolution path.
    const s = stubDb([
      { id: "in", direction: "IN", barcode: "ITEM-1", variance_name: "Ops Sheet Only — No Gate / DT / Odoo Record" },
    ]);
    const res = await resolveStaleOpenVariances(
      s.db,
      "run-2",
      "2026-08-01",
      [cityResult([], [event({ direction: "OUT" })])],
      REPORTED
    );
    expect(s.deleted).toHaveLength(0);
    expect(res.resolvedLate).toBe(1);
  });

  it("leaves a row that is still current alone", async () => {
    const s = stubDb([
      { id: "cur", direction: "OUT", barcode: "ITEM-1", variance_name: "Odoo Posting Only — No Gate / Ops / DT Record" },
    ]);
    const res = await resolveStaleOpenVariances(
      s.db,
      "run-2",
      "2026-08-01",
      [cityResult([variance()], [event({ outcome: "INFO", suppressedReason: null })])],
      REPORTED
    );
    expect(s.deleted).toHaveLength(0);
    expect(s.updated).toHaveLength(0);
    expect(res).toMatchObject({ superseded: 0, resolvedLate: 0 });
  });

  it("does not need full coverage to act on a suppression", async () => {
    // The resolved-late branch requires all four sources, because absence under
    // a downed connector is uninformative. A suppression is POSITIVE evidence
    // from this run, so it stands on partial coverage — exactly like the
    // supersede branch it shares.
    const s = stubDb([
      { id: "old", direction: "OUT", barcode: "ITEM-1", variance_name: "Odoo Posting Only — No Gate / Ops / DT Record" },
    ]);
    const res = await resolveStaleOpenVariances(
      s.db,
      "run-2",
      "2026-08-01",
      [cityResult([], [event()])],
      { MUMBAI: { P: false, S: true, D: true, O: true } } as never
    );
    expect(res.superseded).toBe(1);
    expect(res.resolvedLate).toBe(0);
  });
});
