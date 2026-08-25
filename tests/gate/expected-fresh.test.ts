// Keeping the expected list current, and not destroying it by accident.
//
// MEASURED 2026-08-25. The list was a 07:00 snapshot. It held 17 rows for a day
// in which Odoo records ~1,451 movements, and — the telling part — nothing at
// all for tomorrow, every day, though the job explicitly asks for tomorrow too.
// Odoo pickings here are created during the day and reach 'done' quickly, so a
// dawn snapshot can only catch whatever happens to be pending at dawn.
//
// Two behaviours are pinned here. That the list refreshes when it is asked for
// and found stale, and that a failed or empty pull never wipes a good list —
// the second being a bug the first would otherwise have made far more likely,
// since an on-demand refresh runs many times a day rather than once.

import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchExpectedMock = vi.fn();
vi.mock("../../lib/connectors/metabase", () => ({
  metabaseConfigured: () => true,
  runNativeSql: (...a: unknown[]) => fetchExpectedMock(...a),
}));

const { ensureExpectedFresh, refreshExpected, EXPECTED_MAX_AGE_MS } =
  await import("../../lib/gate/expected");

/** Odoo rows, in the shape runNativeSql hands back. */
const odooRows = (n: number) => ({
  rows: Array.from({ length: n }, (_, i) => ({
    barcode: `FUL5ZA241200${String(i).padStart(2, "0")}`,
    product: "Chair", so_number: "ON-1", ticket_id: "T-1", customer: "A",
    picking_ref: "GUR/OUT/1", warehouse_code: "GUR",
    direction: "Out", job_type: "new", move_state: "assigned",
  })),
});

/**
 * Stub Postgres, tracking whether the day's rows were DELETED — which is the
 * whole question for the second half of these tests.
 */
function stubDb(opts: { cachedCount?: number; refreshedAt?: string | null } = {}) {
  const state = { deleted: false, inserted: 0, count: opts.cachedCount ?? 0 };
  const db = {
    from() {
      return {
        select(_cols: string, o?: { count?: string; head?: boolean }) {
          if (o?.head) {
            const self = { eq: () => self, then: (r: (v: unknown) => void) => r({ count: state.count }) };
            return self;
          }
          const self = {
            eq: () => self,
            order: () => self,
            limit: () => self,
            maybeSingle: async () => ({
              data: opts.refreshedAt === undefined ? null : { refreshed_at: opts.refreshedAt },
              error: null,
            }),
          };
          return self;
        },
        delete() {
          const self = { eq: () => { state.deleted = true; state.count = 0; return self; } };
          return self;
        },
        upsert: async (chunk: unknown[]) => { state.inserted += chunk.length; return { error: null }; },
      };
    },
  };
  return { db: db as never, state };
}

beforeEach(() => { fetchExpectedMock.mockReset(); vi.unstubAllEnvs(); vi.stubEnv("METABASE_ODOO_DB_ID", "9"); });

describe("an empty pull never wipes a good list", () => {
  it("keeps yesterday's rows when Odoo returns nothing and rows exist", async () => {
    // One bad Metabase minute — a timeout, a session expiry, Odoo restarting —
    // must not blank the day's expectations. Zero rows is equally the shape of
    // a failed query and of a quiet day, and the two are indistinguishable here.
    fetchExpectedMock.mockResolvedValue({ rows: [] });
    const { db, state } = stubDb({ cachedCount: 17 });
    const r = await refreshExpected(db, "2026-08-25");
    expect(r.kept).toBe(true);
    expect(state.deleted).toBe(false);
  });

  it("still clears the day when there was nothing cached to protect", async () => {
    fetchExpectedMock.mockResolvedValue({ rows: [] });
    const { db, state } = stubDb({ cachedCount: 0 });
    const r = await refreshExpected(db, "2026-08-25");
    expect(r.kept).toBeUndefined();
    expect(state.deleted).toBe(true);
  });

  it("replaces the list when the pull genuinely returns rows", async () => {
    // The delete is what lets a CANCELLED picking disappear, so it must still
    // happen on a real answer.
    fetchExpectedMock.mockResolvedValue(odooRows(6));
    const { db, state } = stubDb({ cachedCount: 17 });
    await refreshExpected(db, "2026-08-25");
    expect(state.deleted).toBe(true);
    expect(state.inserted).toBe(6);
  });
});

describe("the list refreshes when it is asked for and found stale", () => {
  it("refreshes a list older than the age limit", async () => {
    fetchExpectedMock.mockResolvedValue(odooRows(4));
    const old = new Date(Date.now() - EXPECTED_MAX_AGE_MS - 60_000).toISOString();
    const { db, state } = stubDb({ cachedCount: 3, refreshedAt: old });
    const r = await ensureExpectedFresh(db, "2026-08-25");
    expect(r.refreshed).toBe(true);
    expect(state.inserted).toBe(4);
  });

  it("leaves a recent list alone", async () => {
    // A busy gate must not pay a multi-second Metabase query every few scans
    // for a list that has barely moved.
    const recent = new Date(Date.now() - 30_000).toISOString();
    const { db, state } = stubDb({ cachedCount: 3, refreshedAt: recent });
    const r = await ensureExpectedFresh(db, "2026-08-25");
    expect(r.refreshed).toBe(false);
    expect(r.reason).toBe("fresh");
    expect(state.inserted).toBe(0);
    expect(fetchExpectedMock).not.toHaveBeenCalled();
  });

  it("always fetches when there is no list at all", async () => {
    // The state every new business day starts in. However recently a refresh
    // may have been attempted, a day with nothing cached is worth asking about.
    fetchExpectedMock.mockResolvedValue(odooRows(2));
    const { db } = stubDb({ cachedCount: 0, refreshedAt: null });
    const r = await ensureExpectedFresh(db, "2026-08-26");
    expect(r.refreshed).toBe(true);
  });

  it("never throws when Odoo is unreachable", async () => {
    // The list aids a check that is still silent. Odoo being down must cost the
    // freshness of a warning, never the ability to record a movement.
    fetchExpectedMock.mockRejectedValue(new Error("metabase timeout"));
    const old = new Date(Date.now() - EXPECTED_MAX_AGE_MS - 1).toISOString();
    const { db } = stubDb({ cachedCount: 3, refreshedAt: old });
    const r = await ensureExpectedFresh(db, "2026-08-25");
    expect(r.refreshed).toBe(false);
    expect(r.reason).toBe("failed");
  });

  it("three phones at shift change cause ONE Metabase query, not three", async () => {
    // The failure this prevents is real: the app opens, a trip starts and the
    // close screen all ask, and they arrive within seconds of each other at
    // shift change. Tripling load on the slowest dependency in the system to
    // produce three identical answers is the wrong way to be current.
    let resolve!: (v: unknown) => void;
    fetchExpectedMock.mockReturnValue(new Promise((r) => { resolve = r; }));
    const old = new Date(Date.now() - EXPECTED_MAX_AGE_MS - 1).toISOString();
    const { db } = stubDb({ cachedCount: 3, refreshedAt: old });

    const all = Promise.all([
      ensureExpectedFresh(db, "2026-08-25"),
      ensureExpectedFresh(db, "2026-08-25"),
      ensureExpectedFresh(db, "2026-08-25"),
    ]);
    await new Promise((r) => setTimeout(r, 10));
    resolve(odooRows(5));
    const results = await all;

    expect(fetchExpectedMock).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.refreshed)).toHaveLength(1);
  });
});
