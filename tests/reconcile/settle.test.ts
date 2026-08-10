// The settle sweep closes rows in bulk, which makes it the one scheduled job
// whose bugs are expensive and quiet. Every guard below exists because the
// alternative failure is "thirteen thousand real chase items were closed and
// nobody noticed".

import { describe, expect, it } from "vitest";
import {
  AGED_OUT_REASON,
  MIN_AGE_DAYS,
  NO_ACTION_REASON,
  settleUnactionableVariances,
} from "../../lib/reconcile/settle";

interface Row {
  id: string;
  city: string;
  business_date: string;
  direction: string | null;
  variance_name: string;
  bucket: string | null;
  job_type: string | null;
  note: string | null;
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: over.id ?? "id-1",
    city: "MUMBAI",
    business_date: "2026-07-01",
    direction: "OUT",
    variance_name: "Gate Register Only — No Ops / DT / Odoo Record",
    bucket: "REAL",
    job_type: null,
    note: null,
    ...over,
  };
}

/**
 * A database that answers the two reads this module makes and records the
 * writes. Modelled on the real shapes: the source_rows probe is
 * select→order→limit, the variance read is select→eq→lt→order→range, and the
 * write is update→in→eq.
 */
function stubDb(opts: { floor?: string | null; rows?: Row[] }) {
  const updates: { patch: Record<string, unknown>; ids: string[]; statusGuard?: string }[] = [];
  const rows = opts.rows ?? [];

  const db = {
    from(table: string) {
      if (table === "source_rows") {
        return {
          select: () => ({
            order: () => ({
              limit: () =>
                Promise.resolve({
                  data: opts.floor === undefined || opts.floor === null
                    ? []
                    : [{ business_date: opts.floor }],
                  error: null,
                }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            lt: (_col: string, cutoff: string) => ({
              order: () => ({
                range: (from: number, to: number) =>
                  Promise.resolve({
                    data: rows.filter((r) => r.business_date < cutoff).slice(from, to + 1),
                    error: null,
                  }),
              }),
            }),
          }),
        }),
        update(patch: Record<string, unknown>) {
          return {
            in(_col: string, ids: string[]) {
              const entry: { patch: Record<string, unknown>; ids: string[]; statusGuard?: string } =
                { patch, ids };
              updates.push(entry);
              return {
                eq(_c: string, v: string) {
                  entry.statusGuard = v;
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        },
      };
    },
  };
  return { db: db as never, updates };
}

const TODAY = "2026-08-10";

describe("settleUnactionableVariances", () => {
  it("refuses to run at all when source_rows is empty", async () => {
    // A fresh database, a restore in progress, or a prune that over-ran all look
    // identical here — and reading any of them as "every date has expired" would
    // close the entire table.
    const s = stubDb({ floor: null, rows: [row()] });
    const res = await settleUnactionableVariances(s.db, { today: TODAY });
    expect(res.cutoff).toBeNull();
    expect(res.skipped).toMatch(/source_rows is empty/);
    expect(s.updates).toHaveLength(0);
  });

  it("never settles a date the re-check sweep can still re-run", async () => {
    // Retention says the last five days are readable, but migration 0018 re-runs
    // D-2 … D-7 — so a five-day floor must NOT let the sweep reach D-6. Both
    // conditions have to hold, which makes the cutoff the earlier of the two.
    const s = stubDb({ floor: "2026-08-05", rows: [] });
    const res = await settleUnactionableVariances(s.db, { today: TODAY });
    expect(res.cutoff).toBe("2026-08-02"); // TODAY − MIN_AGE_DAYS, not the floor
    expect(MIN_AGE_DAYS).toBe(8);
  });

  it("uses the retention floor when it is older than the age floor", async () => {
    const s = stubDb({ floor: "2026-07-20", rows: [] });
    const res = await settleUnactionableVariances(s.db, { today: TODAY });
    expect(res.cutoff).toBe("2026-07-20");
  });

  it("splits by the SAME label the dashboards read — tier 3 is 'no action'", async () => {
    const s = stubDb({
      floor: "2026-08-03",
      rows: [
        // Tier 3: the engine's own label for these is "None."
        row({ id: "a", variance_name: "All Sources Agree — Barcode Text Differs (OCR/Typo)", bucket: "INFO" }),
        row({ id: "b", variance_name: "Odoo Entry Made Late — Posted Next Day", bucket: "INFO" }),
        // Tier 1: a real chase item whose evidence is simply gone.
        row({ id: "c", variance_name: "Gate Register Only — No Ops / DT / Odoo Record", bucket: "REAL" }),
      ],
    });
    const res = await settleUnactionableVariances(s.db, { today: TODAY });
    expect(res.noAction).toBe(2);
    expect(res.agedOut).toBe(1);

    const byReason = Object.fromEntries(
      s.updates.map((u) => [u.patch.closure_reason as string, u.ids])
    );
    expect(byReason[NO_ACTION_REASON]).toEqual(["a", "b"]);
    expect(byReason[AGED_OUT_REASON]).toEqual(["c"]);
  });

  it("records the closure as machine-set: a reason, and no closer", async () => {
    const s = stubDb({ floor: "2026-08-03", rows: [row()] });
    await settleUnactionableVariances(s.db, { today: TODAY });
    expect(s.updates[0].patch).toMatchObject({
      status: "closed",
      closed_by: null,
      closure_reason: AGED_OUT_REASON,
    });
    // closed_at is set so prune_expired can eventually reclaim these; a NULL
    // would make `closed_at < now() - 90 days` evaluate NULL and keep them
    // forever, which is the pile this sweep exists to stop.
    expect(s.updates[0].patch.closed_at).toEqual(expect.any(String));
  });

  it("re-asserts status='open' on the write, so a human decision in between wins", async () => {
    const s = stubDb({ floor: "2026-08-03", rows: [row()] });
    await settleUnactionableVariances(s.db, { today: TODAY });
    expect(s.updates[0].statusGuard).toBe("open");
  });

  it("writes nothing on a dry run but reports exactly what it would do", async () => {
    const s = stubDb({
      floor: "2026-08-03",
      rows: [row({ id: "a" }), row({ id: "b", variance_name: "Odoo Entry Made Late — Posted Next Day", bucket: "INFO" })],
    });
    const res = await settleUnactionableVariances(s.db, { today: TODAY, dryRun: true });
    expect(res.agedOut).toBe(1);
    expect(res.noAction).toBe(1);
    expect(res.scanned).toBe(2);
    expect(s.updates).toHaveLength(0);
  });

  it("touches nothing when the whole backlog is inside the window", async () => {
    const s = stubDb({ floor: "2026-08-03", rows: [row({ business_date: "2026-08-09" })] });
    const res = await settleUnactionableVariances(s.db, { today: TODAY });
    expect(res.scanned).toBe(0);
    expect(s.updates).toHaveLength(0);
  });

  it("reports the spread per city, so one bad city cannot hide in a total", async () => {
    const s = stubDb({
      floor: "2026-08-03",
      rows: [
        row({ id: "a", city: "DELHI" }),
        row({ id: "b", city: "DELHI" }),
        row({ id: "c", city: "PUNE" }),
      ],
    });
    const res = await settleUnactionableVariances(s.db, { today: TODAY });
    expect(res.byCity).toEqual({ DELHI: 2, PUNE: 1 });
  });
});
