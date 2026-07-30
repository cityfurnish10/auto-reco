import { describe, expect, it } from "vitest";
import { defaultPair, lagDaysOf, toPasses, type RunRow } from "../../lib/stock/passes";
import { recheckTargetDate } from "../../lib/reconcile/cron-dates";

const run = (over: Partial<RunRow>): RunRow => ({
  id: "r1",
  business_date: "2026-07-26",
  status: "success",
  trigger: "cron",
  triggered_by: null,
  created_at: "2026-07-27T11:00:00Z",
  completed_at: "2026-07-27T11:01:00Z",
  run_role: null,
  ocr_skipped: null,
  recheck_skipped_reason: null,
  ...over,
});

describe("what counts as a usable pass", () => {
  it("excludes a run that never finished, and says why", () => {
    // completed_at, never created_at: createRun stamps created_at at the START, so
    // a run killed by the 60s ceiling keeps a null completed_at forever — and one
    // such row from 2026-07-20 is still stranded at status='running' in production,
    // because prune_expired only sweeps 'failed'.
    const { passes, excluded } = toPasses([
      run({ id: "dead", status: "running", completed_at: null }),
      run({ id: "ok" }),
    ]);
    expect(passes.map((p) => p.runId)).toEqual(["ok"]);
    expect(excluded).toEqual([
      { runId: "dead", createdAt: "2026-07-27T11:00:00Z", status: "running", reason: "never completed" },
    ]);
  });

  it("keeps a partial run — it reconciled, just not from everything", () => {
    expect(toPasses([run({ status: "partial" })]).passes).toHaveLength(1);
  });

  it("lists a failed run rather than leaving an unexplained hole", () => {
    const { excluded } = toPasses([run({ status: "failed", completed_at: null })]);
    expect(excluded[0].reason).toBe("failed");
  });
});

describe("the lag, derived and never hardcoded", () => {
  it("measures the gap in IST days", () => {
    // 11:01Z on the 27th is 16:31 IST — the same IST day.
    expect(lagDaysOf("2026-07-26", "2026-07-27T11:01:00Z")).toBe(1);
    expect(lagDaysOf("2026-07-26", "2026-07-29T11:01:00Z")).toBe(3);
  });

  it("still classifies correctly across the cadence change", () => {
    // The re-check moved from D+2 to D+3 last week. Any literal offset would
    // misclassify every run on one side of that change; ranking by lag does not.
    const twoDay = toPasses([
      run({ id: "first", completed_at: "2026-07-27T11:01:00Z" }),
      run({ id: "second", completed_at: "2026-07-28T11:01:00Z" }),
    ]).passes;
    const threeDay = toPasses([
      run({ id: "first", completed_at: "2026-07-27T11:01:00Z" }),
      run({ id: "second", completed_at: "2026-07-29T11:01:00Z" }),
    ]).passes;
    expect(twoDay.map((p) => p.role)).toEqual(["primary", "recheck"]);
    expect(threeDay.map((p) => p.role)).toEqual(["primary", "recheck"]);
  });

  it("agrees with the cron's own re-check target", () => {
    // If these ever disagree the page labels the wrong run as the re-check.
    const business = "2026-07-26";
    const afternoon = new Date("2026-07-29T11:30:00Z"); // 17:00 IST
    expect(recheckTargetDate(afternoon)).toBe(business);
    expect(lagDaysOf(business, afternoon.toISOString())).toBe(3);
  });
});

describe("the role", () => {
  it("trusts the stored marker over any inference", () => {
    const { passes } = toPasses([
      run({ id: "a", run_role: "recheck", completed_at: "2026-07-27T11:01:00Z" }),
    ]);
    expect(passes[0].role).toBe("recheck");
    expect(passes[0].roleSource).toBe("marker");
  });

  it("infers from the lag rank when the marker is absent (pre-0017 runs)", () => {
    const { passes } = toPasses([
      run({ id: "a", completed_at: "2026-07-27T11:01:00Z" }),
      run({ id: "b", completed_at: "2026-07-29T11:01:00Z" }),
    ]);
    expect(passes.map((p) => p.roleSource)).toEqual(["inferred", "inferred"]);
    expect(passes.map((p) => p.role)).toEqual(["primary", "recheck"]);
  });

  it("calls a human's re-run adhoc, whatever its lag", () => {
    const { passes } = toPasses([
      run({ id: "a", completed_at: "2026-07-27T11:01:00Z" }),
      run({ id: "b", trigger: "manual", triggered_by: "u1", completed_at: "2026-07-29T11:01:00Z" }),
    ]);
    expect(passes.find((p) => p.runId === "b")!.role).toBe("adhoc");
  });
});

describe("many runs on one date", () => {
  // Measured reality: a single date carries between 1 and 7 usable runs, because
  // manual re-runs are unlimited. Ordinal position is not a definition.
  const seven = [
    run({ id: "1", completed_at: "2026-07-27T11:01:00Z" }),
    run({ id: "2", trigger: "manual", completed_at: "2026-07-27T12:01:00Z" }),
    run({ id: "3", trigger: "manual", completed_at: "2026-07-27T13:01:00Z" }),
    run({ id: "4", completed_at: "2026-07-29T11:01:00Z" }),
    run({ id: "5", trigger: "manual", completed_at: "2026-07-29T12:01:00Z" }),
    run({ id: "6", status: "running", completed_at: null }),
    run({ id: "7", trigger: "manual", completed_at: "2026-07-30T11:01:00Z" }),
  ];

  it("collapses same-day re-pulls into one pass and marks the rest superseded", () => {
    const { passes } = toPasses(seven);
    const day1 = passes.filter((p) => p.lagDays === 1);
    expect(day1).toHaveLength(3);
    expect(day1.filter((p) => !p.supersededInLagClass).map((p) => p.runId)).toEqual(["3"]);
  });

  it("still offers every run for hand-picking", () => {
    expect(toPasses(seven).passes).toHaveLength(6); // all but the never-completed one
  });
});

describe("the default pair", () => {
  const withSnaps = (rows: RunRow[]) => {
    const { passes } = toPasses(rows);
    for (const p of passes) p.hasSnapshot = true;
    return passes;
  };

  it("opens on the earliest against the latest after it", () => {
    const pair = defaultPair(
      withSnaps([
        run({ id: "a", completed_at: "2026-07-27T11:01:00Z" }),
        run({ id: "b", completed_at: "2026-07-29T11:01:00Z" }),
        run({ id: "c", completed_at: "2026-07-30T11:01:00Z" }),
      ])
    );
    expect([pair?.a.runId, pair?.b.runId]).toEqual(["a", "c"]);
  });

  it("offers nothing when only one check has run", () => {
    expect(defaultPair(withSnaps([run({ id: "a" })]))).toBeNull();
  });

  it("offers nothing when a run has no stored snapshot", () => {
    // A pair that would yield no numbers is worse than no pair at all.
    const { passes } = toPasses([
      run({ id: "a", completed_at: "2026-07-27T11:01:00Z" }),
      run({ id: "b", completed_at: "2026-07-29T11:01:00Z" }),
    ]);
    expect(defaultPair(passes)).toBeNull();
  });

  it("keeps a run that fired before the day shut out of the default", () => {
    const passes = withSnaps([
      run({ id: "early", completed_at: "2026-07-26T09:00:00Z" }), // lag 0
      run({ id: "a", completed_at: "2026-07-27T11:01:00Z" }),
      run({ id: "b", completed_at: "2026-07-29T11:01:00Z" }),
    ]);
    expect(passes.find((p) => p.runId === "early")!.preClose).toBe(true);
    expect(defaultPair(passes)?.a.runId).toBe("a");
  });
});

describe("no runs at all", () => {
  it("returns empty rather than throwing", () => {
    expect(toPasses([])).toEqual({ passes: [], excluded: [] });
    expect(defaultPair([])).toBeNull();
  });
});
