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
  // Migration 0013. Absent on purpose in most fixtures — a row written before
  // the column existed must still be judged, conservatively.
  reported_p?: boolean;
  reported_s?: boolean;
  reported_d?: boolean;
  reported_o?: boolean;
}

/**
 * @param noReportedColumns Simulate a database without migration 0013: the wide
 *   SELECT fails with PostgREST's undefined_column, exactly as production does
 *   (probed: `code: "42703", message: "column variances.reported_zzz does not
 *   exist"`). Without this the retry path is unreachable from a test, because
 *   the stub ignores its column argument and never errors — which is how dead
 *   defensive code stays dead.
 */
function stubDb(stored: Stored[], noReportedColumns = false) {
  const deleted: string[][] = [];
  const updated: { patch: Record<string, unknown>; ids: string[] }[] = [];
  const columnsAsked: string[] = [];
  const db = {
    from() {
      return {
        select: (columns: string) => {
          columnsAsked.push(columns);
          const fail = noReportedColumns && columns.includes("reported_");
          const rows = fail
            ? []
            : stored.map((r) =>
                columns.includes("reported_")
                  ? r
                  : {
                      id: r.id,
                      direction: r.direction,
                      barcode: r.barcode,
                      variance_name: r.variance_name,
                    }
              );
          return {
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    range: (from: number, to: number) =>
                      Promise.resolve(
                        fail
                          ? {
                              data: null,
                              error: {
                                code: "42703",
                                message: "column variances.reported_p does not exist",
                              },
                            }
                          : { data: rows.slice(from, to + 1), error: null }
                      ),
                  }),
                }),
              }),
            }),
          };
        },
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
  return { db: db as never, deleted, updated, columnsAsked };
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

  // ── the absence gate ──────────────────────────────────────────────────────
  //
  // The bug it closes, measured 2026-08-11: 42 REAL rows could never be
  // retired, 41 of them Delhi 2026-08-09. Every one accused Odoo of not holding
  // a unit Odoo demonstrably held — checked straight against stock_move_line,
  // 41 of 41 found, all posted on the business date itself. They were stuck
  // because the absence branch demands all FOUR sources report, and Delhi has no
  // guard register for that date, so reported_p is false forever. A gate on a
  // book that is never coming decides the fate of an accusation against Odoo.
  describe("the absence gate", () => {
    const PARTIAL = { MUMBAI: { P: false, S: true, D: true, O: true } } as never;

    it("retires a row whose accused book now holds the unit, without full coverage", async () => {
      // The Delhi shape: "Not Posted in Odoo" accuses O and nothing else, and
      // the ledger now says O. The guard register is irrelevant to that claim
      // and must not be able to veto it.
      const s = stubDb([
        {
          id: "old",
          direction: "OUT",
          barcode: "ITEM-1",
          variance_name: "Moved on Floor + DT — Not Posted in Odoo",
          reported_p: false, reported_s: false, reported_d: true, reported_o: true,
        },
      ]);
      const res = await resolveStaleOpenVariances(
        s.db,
        "run-2",
        "2026-08-01",
        [
          cityResult(
            [],
            [
              event({
                outcome: "CLEAN",
                suppressedReason: null,
                present: { P: false, S: true, D: true, O: true },
              }),
            ]
          ),
        ],
        PARTIAL
      );
      expect(res.resolvedLate).toBe(1);
      expect(s.updated[0].patch).toMatchObject({ note: RESOLVED_LATE_NOTE, bucket: "INFO" });
    });

    it("does not retire when only SOME of the accused books turned up", async () => {
      // "Gate + Ops Confirm — No DT Scan or Odoo Post" accuses two. DT arriving
      // makes the row's NAME wrong; it does not make the row untrue.
      const s = stubDb([
        {
          id: "old",
          direction: "OUT",
          barcode: "ITEM-1",
          variance_name: "Gate + Ops Confirm — No DT Scan or Odoo Post",
          reported_p: true, reported_s: true, reported_d: true, reported_o: true,
        },
      ]);
      const res = await resolveStaleOpenVariances(
        s.db,
        "run-2",
        "2026-08-01",
        [
          cityResult(
            [],
            [
              event({
                outcome: "CLEAN",
                suppressedReason: null,
                present: { P: true, S: true, D: true, O: false },
              }),
            ]
          ),
        ],
        PARTIAL
      );
      expect(res.resolvedLate).toBe(0);
      expect(s.updated).toHaveLength(0);
    });

    it("does not retire on the source the row's own name says was PRESENT", async () => {
      // The tautology. "Gate Register Only" with the gate register still the
      // only book holding it is the row exactly as it was raised. A gate keyed
      // on varianceSource() would fire here — and on 73% of the live queue.
      const s = stubDb([
        {
          id: "old",
          direction: "OUT",
          barcode: "ITEM-1",
          variance_name: "Gate Register Only — No Ops / DT / Odoo Record",
          reported_p: true, reported_s: true, reported_d: true, reported_o: true,
        },
      ]);
      const res = await resolveStaleOpenVariances(
        s.db,
        "run-2",
        "2026-08-01",
        [
          cityResult(
            [],
            [
              event({
                outcome: "CLEAN",
                suppressedReason: null,
                present: { P: true, S: false, D: false, O: false },
              }),
            ]
          ),
        ],
        PARTIAL
      );
      expect(res.resolvedLate).toBe(0);
    });

    it("leaves the full-coverage branch doing its old job", async () => {
      // A name with no testable absence claim, on a fully covered run: the gate
      // declines and the original branch still resolves it. The new branch adds
      // reach; it must not take any away.
      const s = stubDb([
        {
          id: "old",
          direction: "OUT",
          barcode: "ITEM-1",
          variance_name: "All Sources Agree — Barcode Text Differs (OCR/Typo)",
          reported_p: true, reported_s: true, reported_d: true, reported_o: true,
        },
      ]);
      const res = await resolveStaleOpenVariances(
        s.db,
        "run-2",
        "2026-08-01",
        [cityResult([], [event({ outcome: "CLEAN", suppressedReason: null, present: ALL })])],
        REPORTED
      );
      expect(res.resolvedLate).toBe(1);
    });

    it("still refuses under partial coverage when the gate cannot speak", async () => {
      // Same row, same evidence, one source down. Nothing retires it — which is
      // the behaviour that existed before, preserved for exactly the rows the
      // gate has no opinion on.
      const s = stubDb([
        {
          id: "old",
          direction: "OUT",
          barcode: "ITEM-1",
          variance_name: "All Sources Agree — Barcode Text Differs (OCR/Typo)",
          reported_p: true, reported_s: true, reported_d: true, reported_o: true,
        },
      ]);
      const res = await resolveStaleOpenVariances(
        s.db,
        "run-2",
        "2026-08-01",
        [cityResult([], [event({ outcome: "CLEAN", suppressedReason: null, present: ALL })])],
        PARTIAL
      );
      expect(res.resolvedLate).toBe(0);
    });

    it("keys the ledger lookup per direction", async () => {
      // The OUT leg went clean in Odoo; the IN leg's own row must not read that
      // as its own evidence. Same argument as the suppression branch above, and
      // the reason run.ts's odooSameDay/odooNextDay flags are direction-keyed.
      const s = stubDb([
        {
          id: "in",
          direction: "IN",
          barcode: "ITEM-1",
          variance_name: "Moved on Floor + DT — Not Posted in Odoo",
          reported_p: false, reported_s: false, reported_d: true, reported_o: true,
        },
      ]);
      const res = await resolveStaleOpenVariances(
        s.db,
        "run-2",
        "2026-08-01",
        [
          cityResult(
            [],
            [event({ direction: "OUT", outcome: "CLEAN", suppressedReason: null, present: ALL })]
          ),
        ],
        PARTIAL
      );
      expect(res.resolvedLate).toBe(0);
    });

    it("falls back to the strictest reading when reported_* was never stored", async () => {
      // Pre-0013 row: no reported_* at all. The fallback assumes every source
      // reported, so the WHOLE absence set must be present — fewer rows retire,
      // never more. Here Odoo alone is accused and Odoo is present, so it still
      // clears; the sibling test below shows the stricter half.
      const s = stubDb([
        {
          id: "old",
          direction: "OUT",
          barcode: "ITEM-1",
          variance_name: "Moved on Floor + DT — Not Posted in Odoo",
        },
      ]);
      const res = await resolveStaleOpenVariances(
        s.db,
        "run-2",
        "2026-08-01",
        [
          cityResult(
            [],
            [
              event({
                outcome: "CLEAN",
                suppressedReason: null,
                present: { P: false, S: false, D: true, O: true },
              }),
            ]
          ),
        ],
        PARTIAL
      );
      expect(res.resolvedLate).toBe(1);
    });

    it("survives a database that has never had migration 0013", async () => {
      // Migrations here are applied BY HAND, so a deploy can legitimately meet a
      // database without reported_*. The wide SELECT then fails with 42703, and
      // if that is not caught the WHOLE pass throws — taking the supersede and
      // full-coverage branches down with it, which is strictly worse than the
      // bug this gate fixes. Retry narrow, and keep going.
      const s = stubDb(
        [
          {
            id: "old",
            direction: "OUT",
            barcode: "ITEM-1",
            variance_name: "Moved on Floor + DT — Not Posted in Odoo",
          },
        ],
        true // no reported_* columns
      );
      const res = await resolveStaleOpenVariances(
        s.db,
        "run-2",
        "2026-08-01",
        [
          cityResult(
            [],
            [
              event({
                outcome: "CLEAN",
                suppressedReason: null,
                present: { P: false, S: false, D: true, O: true },
              }),
            ]
          ),
        ],
        PARTIAL
      );
      // It asked for the wide columns, was refused, retried narrow, and still
      // retired the row on the strict all-reported reading.
      expect(s.columnsAsked.some((c) => c.includes("reported_p"))).toBe(true);
      expect(s.columnsAsked.some((c) => !c.includes("reported_p"))).toBe(true);
      expect(res.resolvedLate).toBe(1);
    });

    it("the strict fallback holds a multi-source claim to all of it", async () => {
      const s = stubDb([
        {
          id: "old",
          direction: "OUT",
          barcode: "ITEM-1",
          variance_name: "Ops Sheet Only — No Gate / DT / Odoo Record",
        },
      ]);
      const res = await resolveStaleOpenVariances(
        s.db,
        "run-2",
        "2026-08-01",
        [
          cityResult(
            [],
            [
              // D and O arrived; the guard register never did. With reported_*
              // stored this would retire (P was never a testable claim). Without
              // it, the fallback declines rather than guessing.
              event({
                outcome: "CLEAN",
                suppressedReason: null,
                present: { P: false, S: true, D: true, O: true },
              }),
            ]
          ),
        ],
        PARTIAL
      );
      expect(res.resolvedLate).toBe(0);
    });
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
