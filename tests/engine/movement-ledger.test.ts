import { describe, expect, it } from "vitest";
import { runReconciliation } from "../../lib/engine/run";
import { canonicalize } from "../../lib/engine/barcode";
import { buildSampleRowsByCity } from "../../lib/sample-raw-sources";
import { VARIANCE } from "../../lib/engine/variance-names";
import type { MovementEvent, SourceRow } from "../../lib/engine/types";

const RUN = "2026-07-12";

function r(p: Partial<SourceRow> & Pick<SourceRow, "source" | "direction" | "barcode">): SourceRow {
  return { date: RUN, ...p } as SourceRow;
}

// A fully-reconciled decoy so run-date derivation has an anchor. Its own event
// is the CLEAN case, which is convenient — it is also what the table exists for.
function anchor(): SourceRow[] {
  return [
    r({ source: "PHYSICAL", direction: "OUT", barcode: "ANCHOR-OK-1", status: "done", date: RUN }),
    r({ source: "SHEET", direction: "OUT", barcode: "ANCHOR-OK-1", status: "done" }),
    r({ source: "DT", direction: "OUT", barcode: "ANCHOR-OK-1", status: "done", date: RUN }),
    r({ source: "ODOO", direction: "OUT", barcode: "ANCHOR-OK-1", status: "done", createdOn: RUN }),
  ];
}

const find = (events: MovementEvent[], barcode: string, direction: "IN" | "OUT") =>
  events.filter((e) => e.barcode === canonicalize(barcode) && e.direction === direction);

describe("movement ledger — the row `variances` cannot carry", () => {
  it("records a fully reconciled unit, which today leaves no trace at all", () => {
    // The whole point of migration 0015. The ladder returns null for this unit
    // and run.ts pushes nothing, so before the ledger the only surviving
    // evidence it moved was the run_city_stats.movements integer.
    const res = runReconciliation(anchor(), "MUMBAI");
    const [ev] = find(res.movement_events, "ANCHOR-OK-1", "OUT");

    expect(ev).toBeDefined();
    expect(ev.outcome).toBe("CLEAN");
    expect(ev.varianceNames).toEqual([]);
    expect(ev.worstPriority).toBeNull();
    expect(ev.suppressedReason).toBeNull();
    expect(ev.isMovement).toBe(true);
    expect(ev.present).toEqual({ P: true, S: true, D: true, O: true });
    expect(res.variances.find((v) => v.barcode === canonicalize("ANCHOR-OK-1"))).toBeUndefined();
  });

  it("carries the engine's own movement count, so the leaderboard cannot drift", () => {
    const rows = buildSampleRowsByCity(RUN);
    for (const [city, cityRows] of Object.entries(rows)) {
      const res = runReconciliation(cityRows, city as never);
      expect(
        res.movement_events.filter((e) => e.isMovement).length,
        `${city}: ledger movements != summary.movements`
      ).toBe(res.summary.movements);
    }
  });

  it("reads presence AFTER the OCR-orphan fold, not while views are built", () => {
    // THE regression guard. mergeGuardPresence mutates target.P after the views
    // exist, so a ledger built during buildViews would record present.P=false
    // for the merged unit — reintroducing, in stored data this time, the exact
    // false negative the merge exists to remove. And unlike a UI bug this one
    // is unfixable later: the ledger is the record.
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "SHEET", direction: "OUT", barcode: "COUCHAAAAA", status: "done", ticketId: "654321" }),
        r({ source: "DT", direction: "OUT", barcode: "COUCHAAAAA", status: "done", date: RUN }),
        r({ source: "ODOO", direction: "OUT", barcode: "COUCHAAAAA", status: "done", createdOn: RUN }),
        // The guard's OCR-mangled spelling of the same unit, same ticket.
        r({ source: "PHYSICAL", direction: "OUT", barcode: "C0UCHXYZ99", status: "done", ticketId: "654321" }),
      ],
      "MUMBAI"
    );
    expect(res.warnings.some((w) => w.startsWith("OCR merge"))).toBe(true);

    const merged = find(res.movement_events, "COUCHAAAAA", "OUT");
    expect(merged).toHaveLength(1);
    expect(merged[0].present.P, "guard presence lost — presence was snapshotted too early").toBe(true);

    // And the orphan must not survive as a phantom gate-only movement.
    expect(find(res.movement_events, "C0UCHXYZ99", "OUT")).toHaveLength(0);
  });

  it("covers every emitted variance, and puts a CROSS row on both legs", () => {
    const rows = buildSampleRowsByCity(RUN);
    for (const [city, cityRows] of Object.entries(rows)) {
      const res = runReconciliation(cityRows, city as never);
      const keyed = new Set(res.movement_events.map((e) => `${e.direction}::${e.barcode}`));
      for (const v of res.variances) {
        const legs = v.direction === "CROSS" ? ["IN", "OUT"] : [v.direction];
        for (const d of legs) {
          expect(
            keyed.has(`${d}::${v.barcode}`),
            `${city}: ${v.variance_name} ${v.barcode} has no ${d} event`
          ).toBe(true);
        }
      }
    }
  });

  it("labels a flagged unit by its worst bucket and priority", () => {
    const res = runReconciliation(
      [
        ...anchor(),
        // Gate only — a REAL loss.
        r({ source: "PHYSICAL", direction: "OUT", barcode: "GATEONLY001", status: "done", date: RUN }),
      ],
      "MUMBAI"
    );
    const [ev] = find(res.movement_events, "GATEONLY001", "OUT");
    expect(ev.outcome).toBe("REAL");
    expect(ev.varianceNames).toContain(VARIANCE.GATE_ONLY);
    expect(ev.worstPriority).toBe("High");
  });

  it("never emits a row for a spare or a PP box", () => {
    // Those are the count-only layer — they never reach the ladder, so the
    // ledger must not imply they were tracked unit by unit.
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "SHEET", direction: "IN", barcode: "PP BOX - 29", status: "done" }),
        r({ source: "SHEET", direction: "IN", barcode: "SPARE PART 7788", status: "done" }),
      ],
      "MUMBAI"
    );
    for (const e of res.movement_events) {
      expect(e.barcode).not.toContain("PPBOX");
      expect(e.barcode).not.toContain("SPARE");
    }
  });

  it("stamps the coverage mask on every event, including suppressed ones", () => {
    const res = runReconciliation(anchor(), "MUMBAI", { P: false, S: true, D: true, O: true });
    expect(res.movement_events.length).toBeGreaterThan(0);
    for (const e of res.movement_events) {
      expect(e.reported.P, "a source that never reported must be recorded as such").toBe(false);
      expect(e.reported.S).toBe(true);
    }
  });

  it("dates every event on the city's derived run date", () => {
    // If this drifts from what upsertVariances writes as business_date, the
    // ledger and the variances key on different dates and stop joining.
    const res = runReconciliation(anchor(), "MUMBAI");
    for (const e of res.movement_events) expect(e.date).toBe(res.date);
  });
});
