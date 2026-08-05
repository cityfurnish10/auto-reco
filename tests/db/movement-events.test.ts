// upsertMovementEvents runs on the nightly critical path. It must never take
// the run down — but it must also never silently skip a night, because a day
// the ledger misses cannot be reconstructed once source_rows is pruned.
//
// The interesting case is the one the 0013 guard next to it does NOT catch: a
// missing TABLE reports 42P01 / PGRST205, not the 42703 / PGRST204 a missing
// COLUMN reports. Copying that guard verbatim would let an unapplied 0015 throw.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { upsertMovementEvents } from "../../lib/db/persist";
import type { CityRunResult, MovementEvent } from "../../lib/engine/types";

function event(over: Partial<MovementEvent> = {}): MovementEvent {
  return {
    barcode: "ITEM-1",
    barcode_display: "ITEM-1",
    city: "MUMBAI",
    direction: "OUT",
    date: "2026-07-26",
    present: { P: true, S: true, D: false, O: false },
    reported: { P: true, S: true, D: true, O: false },
    odooSameDay: false,
    odooNextDay: false,
    odooCreatedToday: false,
    isMovement: true,
    jobType: null,
    soNumber: "SO-1",
    ticketId: "T-1",
    customer: "Ravi",
    product: "Sofa",
    outcome: "CLEAN",
    varianceNames: [],
    worstPriority: null,
    suppressedReason: null,
    ...over,
  };
}

const cityResult = (events: MovementEvent[]): CityRunResult =>
  ({ city: "MUMBAI", movement_events: events }) as unknown as CityRunResult;

function stubDb(replies: { error: { code?: string; message: string } | null }[]) {
  const payloads: Record<string, unknown>[][] = [];
  const conflicts: (string | undefined)[] = [];
  let call = 0;
  const db = {
    from() {
      return {
        upsert(payload: Record<string, unknown>[], opts?: { onConflict?: string }) {
          payloads.push(payload);
          conflicts.push(opts?.onConflict);
          return Promise.resolve(replies[call++] ?? { error: null });
        },
      };
    },
  };
  return { db: db as never, payloads, conflicts, calls: () => call };
}

describe("upsertMovementEvents", () => {
  beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("upserts on the natural key so a re-run updates instead of duplicating", async () => {
    // source_rows plain-inserts and therefore keeps every re-check pass — 4,106
    // stored rows for a date whose run pulled 896. The ledger must behave like
    // variances, not like that.
    const s = stubDb([{ error: null }]);
    const n = await upsertMovementEvents(s.db, "run-1", [cityResult([event()])]);
    expect(n).toBe(1);
    expect(s.conflicts[0]).toBe("business_date,city,direction,barcode");
  });

  it("never writes first_seen_at, so a re-run cannot reset it", async () => {
    const s = stubDb([{ error: null }]);
    await upsertMovementEvents(s.db, "run-1", [cityResult([event()])]);
    const [payload] = s.payloads;
    expect(payload[0]).not.toHaveProperty("first_seen_at");
    expect(payload[0]).toHaveProperty("last_seen_at");
  });

  it("maps the engine's shape onto the columns, flags included", async () => {
    const s = stubDb([{ error: null }]);
    await upsertMovementEvents(s.db, "run-1", [
      cityResult([
        event({
          outcome: "REAL",
          varianceNames: ["Gate Register Only — No Ops / DT / Odoo Record"],
          worstPriority: "High",
          present: { P: true, S: false, D: false, O: false },
        }),
      ]),
    ]);
    expect(s.payloads[0][0]).toMatchObject({
      run_id: "run-1",
      business_date: "2026-07-26",
      city: "MUMBAI",
      direction: "OUT",
      barcode: "ITEM-1",
      present_p: true,
      present_s: false,
      reported_o: false,
      is_movement: true,
      outcome: "REAL",
      worst_priority: "High",
      backfilled: false,
    });
  });

  it("marks backfilled rows, so a reconstruction is never read as a recording", async () => {
    // A backfill re-reads the LIVE sources, so it reports what is true about
    // that night NOW. Without the flag the ledger would overstate history.
    const s = stubDb([{ error: null }]);
    await upsertMovementEvents(s.db, "run-1", [cityResult([event()])], { backfilled: true });
    expect(s.payloads[0][0]).toMatchObject({ backfilled: true });
  });

  it("survives 42P01 — a missing TABLE, which the 0013 guard would not catch", async () => {
    const s = stubDb([
      { error: { code: "42P01", message: 'relation "movement_events" does not exist' } },
    ]);
    await expect(
      upsertMovementEvents(s.db, "run-1", [cityResult([event()])])
    ).resolves.toBe(0);
    expect(s.calls()).toBe(1);
  });

  it("survives PGRST205 — how PostgREST actually reports a missing table", async () => {
    const s = stubDb([
      {
        error: {
          code: "PGRST205",
          message: "Could not find the table 'public.movement_events' in the schema cache",
        },
      },
    ]);
    await expect(
      upsertMovementEvents(s.db, "run-1", [cityResult([event()])])
    ).resolves.toBe(0);
  });

  it("still throws on an unrelated error, so a real bug is not swallowed", async () => {
    const s = stubDb([{ error: { code: "23505", message: "duplicate key value" } }]);
    await expect(
      upsertMovementEvents(s.db, "run-1", [cityResult([event()])])
    ).rejects.toThrow(/duplicate key/);
  });

  it("chunks at 1000 rows", async () => {
    const many = Array.from({ length: 2500 }, (_, i) => event({ barcode: `ITEM-${i}` }));
    const s = stubDb([{ error: null }, { error: null }, { error: null }]);
    const n = await upsertMovementEvents(s.db, "run-1", [cityResult(many)]);
    expect(n).toBe(2500);
    expect(s.payloads.map((p) => p.length)).toEqual([1000, 1000, 500]);
  });

  it("warns once per process, not once per city", async () => {
    // The once-flag is module scope, and the tests above have already tripped
    // it — so this needs a fresh instance of the module, not just a fresh spy.
    // Five cities a night would otherwise be five identical lines in the log.
    vi.resetModules();
    const fresh = await import("../../lib/db/persist");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = { code: "42P01", message: "does not exist" };

    await fresh.upsertMovementEvents(stubDb([{ error: err }]).db, "r", [cityResult([event()])]);
    await fresh.upsertMovementEvents(stubDb([{ error: err }]).db, "r", [cityResult([event()])]);

    expect(warn.mock.calls.filter((c) => String(c[0]).includes("0015"))).toHaveLength(1);
  });

  it("does nothing when there is nothing to write", async () => {
    const s = stubDb([]);
    await expect(upsertMovementEvents(s.db, "run-1", [cityResult([])])).resolves.toBe(0);
    expect(s.calls()).toBe(0);
  });
});
