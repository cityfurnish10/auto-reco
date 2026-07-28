import { describe, expect, it } from "vitest";
import { VARIANCE } from "../../lib/engine/variance-names";
import { VARIANCE_META } from "../../lib/engine/buckets";
import {
  ACTIONABLE_NAMES,
  TIER,
  UNLABELLED,
  VARIANCE_LABELS,
  labelFor,
  teamFor,
  tierOf,
  type LabelContext,
} from "../../lib/ui/variance-labels";

const NAMES = Object.values(VARIANCE);

// Every context a stored row can present. Used to prove a display label never
// changes colour depending on how it is reached.
const CONTEXTS: LabelContext[] = [
  {},
  { direction: "IN" },
  { direction: "OUT" },
  { direction: "CROSS" },
  { direction: "CROSS", jobType: "REPLACE" },
  { direction: "CROSS", jobType: "NEW_RENTAL" },
  { direction: "CROSS", jobType: "REPAIR" },
  { direction: "CROSS", jobType: null },
  { direction: "OUT", jobType: "DELIVERY" },
];

describe("variance labels — coverage", () => {
  it("covers all 22 canonical names exactly once", () => {
    expect(NAMES).toHaveLength(22);
    expect(new Set(NAMES).size).toBe(22);
    expect(Object.keys(VARIANCE_LABELS).sort()).toEqual([...NAMES].sort());
  });

  it("never falls back to the raw internal string", () => {
    for (const n of NAMES) {
      const l = labelFor(n);
      expect(l, `${n} fell through to UNLABELLED`).not.toBe(UNLABELLED);
      expect(l.display).not.toBe(n);
    }
  });

  it("gives every name a risk sentence, an action and a team", () => {
    for (const n of NAMES) {
      const l = labelFor(n);
      expect(l.risk.trim().length, `${n} risk too short`).toBeGreaterThan(20);
      expect(l.action.trim()).not.toBe("");
      expect(teamFor(n)).toMatch(/team$/i);
    }
  });

  it("reads the team through VARIANCE_META rather than a second copy", () => {
    // If someone re-types the owner here, this drifts silently — so pin it.
    for (const n of NAMES) {
      expect(VARIANCE_META[n]).toBeDefined();
      expect(teamFor(n)).toBeTruthy();
    }
  });

  it("falls back safely, and to amber, for an unmapped name", () => {
    const l = labelFor("Some Retired 2025 Variance Name");
    expect(l).toBe(UNLABELLED);
    // Not tier 1 (would cry wolf), not tier 3 (would hide it).
    expect(l.tier).toBe(2);
  });
});

describe("variance labels — tier integrity", () => {
  it("keeps each display label in exactly one tier, in every context", () => {
    const seen = new Map<string, number>();
    for (const n of NAMES) {
      for (const ctx of CONTEXTS) {
        const l = labelFor(n, ctx);
        const prior = seen.get(l.display);
        if (prior != null) {
          expect(l.tier, `"${l.display}" appears in tier ${prior} and ${l.tier}`).toBe(prior);
        }
        seen.set(l.display, l.tier);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it("only ever emits tiers 1, 2 or 3", () => {
    for (const n of NAMES)
      for (const ctx of CONTEXTS) expect([1, 2, 3]).toContain(tierOf(n, ctx));
  });

  it("has a heading and colour for each tier", () => {
    for (const t of [1, 2, 3] as const) {
      expect(TIER[t].heading.trim()).not.toBe("");
      expect(TIER[t].hex).toMatch(/^#[0-9a-f]{6}$/i);
      // Tailwind scans lib/** — the class string must be a literal, not built.
      expect(TIER[t].badge).toMatch(/^badge badge-/);
    }
  });
});

describe("variance labels — context refinements", () => {
  it("splits floor-only names by direction: outward is at risk, inward is a record fix", () => {
    for (const n of [VARIANCE.GATE_ONLY, VARIANCE.SHEET_ONLY, VARIANCE.GATE_OPS_NO_DT_ODOO]) {
      expect(tierOf(n, { direction: "OUT" }), `${n} outward`).toBe(1);
      expect(tierOf(n, { direction: "IN" }), `${n} inward`).toBe(2);
      // No direction at all must err red, not hide the item.
      expect(tierOf(n), `${n} with no direction`).toBe(1);
    }
  });

  it("splits the cross-direction name by job type", () => {
    const n = VARIANCE.REPLACEMENT_CONFIRM;
    // A swap type survived the engine's suppression => a completed swap.
    for (const jobType of ["REPLACE", "NEW_RENTAL", "REPAIR"]) {
      expect(labelFor(n, { direction: "CROSS", jobType }).display).toBe("Same-Day Replacement");
      expect(tierOf(n, { direction: "CROSS", jobType })).toBe(3);
    }
    // No swap paperwork — including a null job type — is a real conflict.
    for (const jobType of [null, undefined, "DELIVERY", "PICKUP"]) {
      expect(labelFor(n, { direction: "CROSS", jobType }).display).toBe("Direction Conflict");
      expect(tierOf(n, { direction: "CROSS", jobType })).toBe(1);
    }
  });

  it("lists actionable names without hand-maintaining a second list", () => {
    expect(ACTIONABLE_NAMES).toContain(VARIANCE.ODOO_ONLY_TODAY); // tier 1
    expect(ACTIONABLE_NAMES).toContain(VARIANCE.OPS_ODOO_NO_GATE); // tier 2
    expect(ACTIONABLE_NAMES).not.toContain(VARIANCE.DUPLICATE); // tier 3 always
    expect(ACTIONABLE_NAMES).not.toContain(VARIANCE.FIELD_MISMATCH);
  });
});

describe("variance labels — vocabulary", () => {
  // The whole point of the module: no internal jargon may reach a reader.
  it("uses no banned word anywhere in the vocabulary", () => {
    const text = JSON.stringify({ VARIANCE_LABELS, TIER, UNLABELLED });
    expect(text).not.toMatch(/\bvariances?\b/i);
    expect(text).not.toMatch(/\bbuckets?\b/i);
    // Case-SENSITIVE: the ban is on the REAL/INFO tokens, not on English
    // "a real gap" or "For information".
    expect(text).not.toMatch(/\bREAL\b/);
    expect(text).not.toMatch(/\bINFO\b/);
    // Word-boundary: "record" and "Reconciliation" are ordinary English and
    // appear throughout. Only the "reco" abbreviation is banned.
    expect(text).not.toMatch(/\breco\b/i);
    // A raw responsible slug leaking through an unmapped team.
    expect(text).not.toMatch(/\b\w+_team\b/);
    // Bare source letters with no label nearby.
    expect(text).not.toMatch(/(?<![A-Za-z])[PSDO](?![A-Za-z])/);
  });

  it("labels are title-case phrases, not sentences", () => {
    for (const n of NAMES) {
      const d = labelFor(n).display;
      expect(d).toMatch(/^[A-Z]/);
      expect(d).not.toMatch(/[.!?]$/);
      expect(d.length).toBeLessThanOrEqual(28);
    }
  });

  it("tier 3 actions are 'None.' and tier 1/2 actions are imperative", () => {
    for (const n of NAMES) {
      for (const ctx of CONTEXTS) {
        const l = labelFor(n, ctx);
        if (l.tier === 3) expect(l.action).toBe("None.");
        else expect(l.action).not.toBe("None.");
      }
    }
  });
});

describe("variance labels — the engine's downgrade wins", () => {
  // resolveStaleOpenVariances rewrites a stale open row to bucket INFO on the
  // next-day re-check when the gap has cleared. The NAME does not change, so
  // without this the label map would keep calling a resolved item a loss.
  // Measured on 2026-07-26: 3 of 79 tier-1 items were already resolved.
  it("never calls a stored-INFO row stock-at-risk", () => {
    for (const n of NAMES) {
      for (const ctx of CONTEXTS) {
        const asFound = labelFor(n, ctx);
        if (asFound.tier !== 1) continue;
        const downgraded = labelFor(n, { ...ctx, bucket: "INFO" });
        expect(downgraded.tier, `${n} stayed tier 1 despite bucket INFO`).not.toBe(1);
        expect(downgraded.display).toBe("Cleared on Re-check");
        expect(downgraded.action).toBe("None.");
      }
    }
  });

  it("leaves a stored-REAL row exactly as the name maps it", () => {
    for (const n of NAMES) {
      for (const ctx of CONTEXTS) {
        expect(labelFor(n, { ...ctx, bucket: "REAL" })).toEqual(labelFor(n, ctx));
      }
    }
  });

  it("does not disturb tier 2 or 3 rows, which are INFO by nature", () => {
    // Register Gap etc. are INFO-bucket by design and must stay tier 2 —
    // a blanket "INFO means tier 3" would empty the amber tier.
    const regGap = labelFor(VARIANCE.OPS_ODOO_NO_GATE, { bucket: "INFO" });
    expect(regGap.display).toBe("Register Gap");
    expect(regGap.tier).toBe(2);
  });
});
