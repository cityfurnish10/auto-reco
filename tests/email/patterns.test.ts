import { describe, expect, it } from "vitest";
import {
  actionFor,
  filedNote,
  patternRows,
  PATTERN_ACTION,
  SOURCE_ORDER,
  OTHER_ROW_LABEL,
} from "../../lib/email/digest/patterns";
import type { CityCoverage } from "../../lib/email/digest/coverage";

const city = (over: Partial<CityCoverage> = {}): CityCoverage => ({
  city: "BANGALORE",
  total: 197,
  byCount: [61, 48, 31, 57],
  missing: { P: 0, S: 0, D: 0, O: 0 },
  reported: { P: true, S: true, D: true, O: true },
  inbound: { total: 98, all4: 30 },
  outbound: { total: 99, all4: 31 },
  // The real 30 Jul Bangalore shape, which sums to 197.
  patterns: {
    "-SDO": 80, PSDO: 61, "-S-O": 26, "P---": 12,
    "-S--": 11, "--DO": 3, "PS--": 2, "PSD-": 1, "PS-O": 1,
  },
  ...over,
});

/** All 15 combinations of four books with at least one present. */
const ALL_KEYS = (() => {
  const out: string[] = [];
  for (let m = 1; m < 16; m++) {
    out.push(SOURCE_ORDER.map((k, i) => ((m >> (3 - i)) & 1 ? k : "-")).join(""));
  }
  return out;
})();

describe("PATTERN_ACTION — every condition has a label", () => {
  it("covers all 15 possible patterns", () => {
    // The owner asked for every condition, not just the ones seen so far. Three
    // (P-DO, P--O, P-D-) have never occurred in production; a pattern that has
    // not happened is not a pattern that cannot.
    expect(ALL_KEYS).toHaveLength(15);
    for (const k of ALL_KEYS) {
      expect(PATTERN_ACTION[k], `no label for ${k}`).toBeTruthy();
    }
  });

  it("labels the owner's example: in all three but not in Odoo", () => {
    expect(PATTERN_ACTION["PSD-"]).toBe("Not posted in Odoo");
  });

  it("says nothing needs doing only when nothing is missing", () => {
    expect(PATTERN_ACTION.PSDO).toBe("All clear");
    for (const k of ALL_KEYS.filter((x) => x !== "PSDO")) {
      expect(PATTERN_ACTION[k]).not.toBe("All clear");
    }
  });

  it("carries no internal jargon", () => {
    for (const v of Object.values(PATTERN_ACTION)) {
      expect(v).not.toMatch(/variance|bucket|\bREAL\b|\bINFO\b|\breco\b/i);
    }
  });
});

describe("patternRows — the rows always add up", () => {
  it("sums to the city total when nothing is collapsed", () => {
    const c = city();
    const rows = patternRows(c, 20);
    expect(rows.reduce((s, r) => s + r.count, 0)).toBe(c.total);
  });

  it("STILL sums to the city total once the tail collapses", () => {
    // The collapse folds the remainder into one row rather than dropping it. A
    // table whose column cannot be added up to the heading above it is worse
    // than no table.
    const c = city();
    const rows = patternRows(c, 3);
    expect(rows).toHaveLength(4); // 3 + the collapsed row
    expect(rows.reduce((s, r) => s + r.count, 0)).toBe(c.total);
    expect(rows[3].action).toContain(OTHER_ROW_LABEL);
  });

  it("orders by count, biggest first", () => {
    const rows = patternRows(city(), 20);
    const counts = rows.map((r) => r.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(rows[0].key).toBe("-SDO");
  });

  it("breaks a tie deterministically rather than by object order", () => {
    const a = patternRows(city({ patterns: { PSDO: 5, "-SDO": 5 } }), 20).map((r) => r.key);
    const b = patternRows(city({ patterns: { "-SDO": 5, PSDO: 5 } }), 20).map((r) => r.key);
    expect(a).toEqual(b);
  });

  it("drops zero-count patterns rather than printing empty rows", () => {
    const rows = patternRows(city({ patterns: { PSDO: 4, "-SDO": 0 } }), 20);
    expect(rows.map((r) => r.key)).toEqual(["PSDO"]);
  });

  it("scales the bar against the city's own biggest row", () => {
    const rows = patternRows(city({ patterns: { PSDO: 100, "-SDO": 50 } }), 20);
    expect(rows[0].share).toBe(100);
    expect(rows[1].share).toBe(50);
  });
});

describe("patternRows — a book that never filed", () => {
  const partial = city({
    reported: { P: false, S: false, D: true, O: true },
    total: 119,
    patterns: { "---O": 61, "--DO": 58 },
  });

  it("marks the absent books 'na', never 'no'", () => {
    // Measured 30 Jul: Mumbai's guard and sheet did not file. A cross there
    // accuses a warehouse of failing to log on a day nobody asked it to.
    const rows = patternRows(partial, 20);
    for (const r of rows) {
      expect(r.marks[0]).toBe("na"); // guard
      expect(r.marks[1]).toBe("na"); // sheet
      expect(r.marks[3]).toBe("yes"); // Odoo filed and saw both patterns
    }
  });

  it("never blames an absent book in the action text", () => {
    for (const r of patternRows(partial, 20)) {
      expect(r.action).not.toMatch(/guard/i);
      expect(r.action).not.toMatch(/sheet/i);
    }
  });

  it("MERGES patterns that differ only in a book that did not file", () => {
    // Measured 2026-08-02 on Pune, whose ops sheet lost its inward tab: PSDO
    // and P-DO both render as tick, dash, tick, tick with the same wording, so
    // the table showed "In every book that filed · 30" directly above "In every
    // book that filed · 29" and a reader could not tell them apart.
    const rows = patternRows(
      city({
        reported: { P: true, S: false, D: true, O: true },
        total: 59,
        patterns: { PSDO: 30, "P-DO": 29 },
      }),
      20
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(59);
    expect(rows[0].marks).toEqual(["yes", "na", "yes", "yes"]);
  });

  it("still sums to the city total after that merge", () => {
    const c = city({
      reported: { P: true, S: false, D: true, O: true },
      total: 90,
      patterns: { PSDO: 30, "P-DO": 29, "-SDO": 20, "--DO": 11 },
    });
    const rows = patternRows(c, 20);
    expect(rows.reduce((s, r) => s + r.count, 0)).toBe(c.total);
    expect(rows).toHaveLength(2); // {P,D,O} and {D,O}
  });

  it("leaves a fully-reported city's rows exactly as they were", () => {
    // The fold has to be the identity when all four filed, or it would quietly
    // rewrite every normal day.
    const c = city();
    expect(patternRows(c, 20).map((r) => r.key)).toEqual(
      Object.entries(c.patterns).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k)
    );
  });

  it("describes what the books that DID file saw", () => {
    expect(actionFor("--DO", partial)).toBe("In every book that filed");
    expect(actionFor("---O", partial)).toBe("Missing from DT");
  });

  it("uses the plain label when every book filed", () => {
    expect(actionFor("-SDO", city())).toBe("Guard post not logging");
  });
});

describe("filedNote", () => {
  it("is silent when all four filed", () => {
    expect(filedNote(city())).toBeNull();
  });

  it("names the absent books and says the columns are blank, not a miss", () => {
    const note = filedNote(city({ reported: { P: false, S: false, D: true, O: true } }));
    expect(note).toContain("Guard and Sheet");
    expect(note).toContain("not a miss");
  });

  it("handles a city where nothing filed at all", () => {
    const note = filedNote(city({ reported: { P: false, S: false, D: false, O: false } }));
    expect(note).toBe("No book filed for this city today.");
  });
});
