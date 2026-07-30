import { describe, expect, it } from "vitest";
import {
  buildRunCitySnapshots,
  MAX_RUN_KEYS_PER_CITY,
} from "../../lib/reconcile/run-snapshot";
import { VARIANCE } from "../../lib/engine/variance-names";
import { RESOLVED_LATE_NOTE } from "../../lib/engine/resolution";
import type { CityRunResult, VarianceRowOut } from "../../lib/engine/types";
import type { City } from "../../lib/sample-data";

const flags = { P: true, S: true, D: true, O: true };

const v = (over: Partial<VarianceRowOut> = {}): VarianceRowOut => ({
  barcode: "CF1",
  city: "DELHI" as City,
  direction: "OUT",
  variance_name: VARIANCE.GATE_ONLY, // tier 1 outward
  priority: "High",
  bucket: "REAL",
  responsible: "ops_team",
  ticket_id: null, so_number: null, customer: null, product: null, job_type: null,
  date: "2026-07-26",
  note: "",
  present: flags,
  reported: flags,
  ...over,
});

const counts = { expected: 0, dt_done: 0, dt_diff: 0, odoo_count: 0, odoo_diff: 0,
  phys_total: 0, sheet_total: 0, dt_total: 0, phys_sheet_match: true, phys_sheet_diff: 0,
  primary_source: "SHEET" as const };

const city = (variances: VarianceRowOut[], over: Partial<CityRunResult> = {}): CityRunResult => ({
  city: "DELHI" as City,
  date: "2026-07-26",
  variances,
  real_variances: [],
  info_variances: [],
  count_in: { ...counts },
  count_out: { ...counts },
  movement_events: [],
  summary: {
    total: variances.length,
    real_count: 0, info_count: 0, high_priority: 0, medium_priority: 0,
    movements: 100, pp_box_count: 0, consumable_count: 0, by_variance: {},
  },
  warnings: [],
  ...over,
});

const reported = { DELHI: flags } as Record<string, typeof flags>;

describe("tiers are counted per unit, at the worst tier", () => {
  it("counts one unit once even when it raises two rows", () => {
    // classifyViews can push a ladder hit AND a duplicate-scan hit for one unit.
    // Counting both would make a later set difference report a change in rows
    // while calling it a change in stock.
    const [s] = buildRunCitySnapshots(
      [city([v(), v({ variance_name: VARIANCE.DUPLICATE })])],
      reported
    );
    expect(s.tier1Count + s.tier2Count + s.tier3Count).toBe(1);
    // emittedCount counts ROWS and is deliberately different.
    expect(s.emittedCount).toBe(2);
  });

  it("gives a unit its worst tier, so stock at risk is not hidden by a tier-3 row", () => {
    const [s] = buildRunCitySnapshots(
      [city([v({ variance_name: VARIANCE.DUPLICATE }), v()])], // INFO first, then tier 1
      reported
    );
    expect(s.tier1Count).toBe(1);
    expect(s.tier3Count).toBe(0);
    expect(s.tier1Keys[0]).toContain(VARIANCE.GATE_ONLY);
  });

  it("puts each unit in exactly one key array", () => {
    const [s] = buildRunCitySnapshots(
      [city([v({ barcode: "CF1" }), v({ barcode: "CF2", variance_name: VARIANCE.DUPLICATE })])],
      reported
    );
    const all = [...s.tier1Keys, ...s.tier2Keys, ...s.tier3Keys];
    expect(new Set(all.map((k) => k.split("|").slice(0, 3).join("|"))).size).toBe(all.length);
  });

  it("stores flagged as tier1 + tier2, matching the database CHECK", () => {
    const [s] = buildRunCitySnapshots([city([v(), v({ barcode: "CF2" })])], reported);
    expect(s.flaggedCount).toBe(s.tier1Count + s.tier2Count);
  });

  it("follows the engine's own downgrade to Cleared on Re-check", () => {
    // A naturally-REAL name stored as INFO with the resolved-late note is tier 3.
    // Recomputing that later from the name alone is impossible, which is why the
    // tier is stored rather than derived.
    const [s] = buildRunCitySnapshots(
      [city([v({ bucket: "INFO", note: RESOLVED_LATE_NOTE })])],
      reported
    );
    expect(s.tier3Count).toBe(1);
    expect(s.flaggedCount).toBe(0);
  });
});

describe("the key budget", () => {
  const many = (n: number, name: string) =>
    Array.from({ length: n }, (_, i) => v({ barcode: `T${name}${i}`, variance_name: name }));

  it("does not truncate at ordinary volume", () => {
    const [s] = buildRunCitySnapshots([city(many(140, VARIANCE.GATE_ONLY))], reported);
    expect(s.keysTruncated).toBe(false);
    expect(s.tier1Keys).toHaveLength(140);
  });

  it("spends the budget worst-tier-first, so tier 1 detail survives", () => {
    const rows = [...many(800, VARIANCE.GATE_ONLY), ...many(800, VARIANCE.DUPLICATE)];
    const [s] = buildRunCitySnapshots([city(rows)], reported);
    expect(s.keysTruncated).toBe(true);
    expect(s.tier1Keys).toHaveLength(800);
    expect(s.tier1Keys.length + s.tier2Keys.length + s.tier3Keys.length).toBe(
      MAX_RUN_KEYS_PER_CITY
    );
  });

  it("keeps the COUNTS complete even when the keys are cut", () => {
    // Counts come from the full lists. Truncating them too would silently
    // understate the day.
    const rows = [...many(800, VARIANCE.GATE_ONLY), ...many(800, VARIANCE.DUPLICATE)];
    const [s] = buildRunCitySnapshots([city(rows)], reported);
    expect(s.tier1Count).toBe(800);
    expect(s.tier3Count).toBe(800);
  });
});

describe("coverage and provenance", () => {
  it("records the mask it was given, including a demoted sheet", () => {
    const [s] = buildRunCitySnapshots(
      [city([v()])],
      { DELHI: { P: true, S: false, D: true, O: true } } as never,
      { sheetTruncated: new Set(["DELHI"] as City[]) }
    );
    expect(s.reported.S).toBe(false);
    expect(s.sheetTruncated).toBe(true);
  });

  it("defaults a city with no reported mask to nothing reported, never to all four", () => {
    const [s] = buildRunCitySnapshots([city([v()])], {});
    expect(s.reported).toEqual({ P: false, S: false, D: false, O: false });
  });

  it("carries the per-city superseded and resolved-late split", () => {
    // superseded rows are hard-DELETEd, so this integer is the only surviving
    // trace they ever existed.
    const [s] = buildRunCitySnapshots([city([v()])], reported, {
      stale: { DELHI: { superseded: 4, resolvedLate: 7 } },
    });
    expect(s.supersededCount).toBe(4);
    expect(s.resolvedLateCount).toBe(7);
  });
});

describe("a city the run did not reconcile", () => {
  it("produces NO row, so the page can say 'not run' rather than zero", () => {
    expect(buildRunCitySnapshots([], reported)).toEqual([]);
  });
});

describe("stability", () => {
  it("emits the same keys in the same order for the same rows", () => {
    const rows = [v({ barcode: "CFZ" }), v({ barcode: "CFA" }), v({ barcode: "CFM" })];
    const a = buildRunCitySnapshots([city(rows)], reported)[0];
    const b = buildRunCitySnapshots([city([...rows].reverse())], reported)[0];
    expect(a.tier1Keys).toEqual(b.tier1Keys);
  });
});
