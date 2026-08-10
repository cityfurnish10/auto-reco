// saveSourceRows is a plain INSERT, and a business date is reconciled about
// SEVEN times a day — once by the primary cron and six more by the pg_cron
// re-check sweep. Every one of those used to store another complete copy.
//
// Measured on the live database 2026-08-10: 108,647 rows for seven retained
// days against ~2,786 rows in a single pull — a 5.6x multiplier. The 7-day
// prune was the only thing containing it, and migration 0022 removes that
// prune, so the duplication had to go first: 15,521 rows/day is ~8.9 GB a year
// against ~1.6 GB deduplicated.
//
// These tests pin the three properties that make the fix safe rather than
// merely smaller.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { saveSourceRows } from "../../lib/db/persist";
import type { SourceRow } from "../../lib/engine/types";
import type { City } from "../../lib/sample-data";

function srcRow(over: Partial<SourceRow> = {}): SourceRow {
  return {
    source: "SHEET",
    direction: "IN",
    barcode: "ITEM-1",
    status: "Received",
    ...over,
  } as SourceRow;
}

const byCity = (rows: SourceRow[]): Record<City, SourceRow[]> =>
  ({ MUMBAI: rows }) as unknown as Record<City, SourceRow[]>;

interface Del {
  business_date?: string;
  source?: string;
  neqRun?: string;
}

function stubDb(opts: { deleteError?: { message: string } } = {}) {
  const inserts: Record<string, unknown>[][] = [];
  const deletes: Del[] = [];
  const order: string[] = [];
  const db = {
    from() {
      return {
        insert(payload: Record<string, unknown>[]) {
          inserts.push(payload);
          order.push("insert");
          return Promise.resolve({ error: null });
        },
        delete() {
          const d: Del = {};
          deletes.push(d);
          order.push("delete");
          const chain = {
            eq(col: string, v: string) {
              if (col === "business_date") d.business_date = v;
              if (col === "source") d.source = v;
              return chain;
            },
            neq(_col: string, v: string) {
              d.neqRun = v;
              return Promise.resolve({ error: opts.deleteError ?? null });
            },
          };
          return chain;
        },
      };
    },
  };
  return { db: db as never, inserts, deletes, order };
}

describe("saveSourceRows keeps one copy per date per source", () => {
  beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("inserts the fresh pull, THEN drops older runs' rows for the same pair", async () => {
    // Order is the guarantee. Delete-first would leave a window where the date
    // has no rows at all, and a reader landing there sees a day that did not
    // happen. This way there are briefly two copies and never zero.
    const s = stubDb();
    await saveSourceRows(s.db, "run-2", "2026-08-06", byCity([srcRow()]));
    expect(s.order).toEqual(["insert", "delete"]);
    expect(s.deletes).toEqual([
      { business_date: "2026-08-06", source: "SHEET", neqRun: "run-2" },
    ]);
  });

  it("scopes the delete per SOURCE, and only to sources this pull actually has", async () => {
    // A connector that failed contributes no rows, so replacing its stored copy
    // with that silence would destroy the day's evidence for it. Its rows are
    // simply left alone — the same reasoning syncWarehouseCalendar applies to
    // an empty calendar read.
    const s = stubDb();
    await saveSourceRows(
      s.db,
      "run-2",
      "2026-08-06",
      byCity([srcRow({ source: "SHEET" }), srcRow({ source: "ODOO" })])
    );
    expect(s.deletes.map((d) => d.source).sort()).toEqual(["ODOO", "SHEET"]);
    // DT and PHYSICAL pulled nothing this run — untouched.
    expect(s.deletes.map((d) => d.source)).not.toContain("DT");
    expect(s.deletes.map((d) => d.source)).not.toContain("PHYSICAL");
  });

  it("preserves genuine duplicate scans WITHIN a pull", async () => {
    // The same barcode logged twice in one source is a reported variance
    // ("Duplicate Scan") that the engine detects from duplicate ROWS. This is
    // why the fix replaces whole pulls instead of upserting on a natural key:
    // any key that collapsed these would delete a real finding.
    const s = stubDb();
    const n = await saveSourceRows(
      s.db,
      "run-2",
      "2026-08-06",
      byCity([srcRow({ barcode: "DUP-1" }), srcRow({ barcode: "DUP-1" })])
    );
    expect(n).toBe(2);
    expect(s.inserts[0]).toHaveLength(2);
    expect(s.inserts[0].every((r) => r.barcode === "DUP-1")).toBe(true);
  });

  it("writes nothing and deletes nothing when the pull is empty", async () => {
    // Every source failed. Deleting here would wipe the whole date.
    const s = stubDb();
    const n = await saveSourceRows(s.db, "run-2", "2026-08-06", byCity([]));
    expect(n).toBe(0);
    expect(s.inserts).toHaveLength(0);
    expect(s.deletes).toHaveLength(0);
  });

  it("does not fail the run when the cleanup delete fails", async () => {
    // The rows for this run are already written, so the reconcile has
    // everything it needs. Throwing here would mark a good night failed and
    // lose the day over housekeeping.
    const s = stubDb({ deleteError: { message: "deadlock detected" } });
    await expect(
      saveSourceRows(s.db, "run-2", "2026-08-06", byCity([srcRow()]))
    ).resolves.toBe(1);
  });

  it("still chunks large feeds at 1000 rows", async () => {
    const s = stubDb();
    const many = Array.from({ length: 2500 }, (_, i) => srcRow({ barcode: `B-${i}` }));
    const n = await saveSourceRows(s.db, "run-2", "2026-08-06", byCity(many));
    expect(n).toBe(2500);
    expect(s.inserts.map((c) => c.length)).toEqual([1000, 1000, 500]);
    // One delete for the one source, after all three chunks.
    expect(s.order).toEqual(["insert", "insert", "insert", "delete"]);
  });
});
