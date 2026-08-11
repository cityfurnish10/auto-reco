// The absence table decides which open rows the engine is allowed to retire on
// its own, so the tests that matter are the ones that stop it retiring too much.
//
// The headline number to keep in mind: gating retirement on varianceSource()
// instead — the obvious-looking fix — fires on roughly SEVEN IN TEN live open
// rows (two independent replays of the live queue on 2026-08-11 put it at 3,576
// and 3,630 of 5,025, the gap being how each treats CROSS-labelled names),
// because for the *_ONLY family varianceSource names the book that DID record
// the unit. The correct gate fires on 55. That gap is what these tests defend.

import { describe, expect, it } from "vitest";
import { ABSENCE_CLAIM, absenceClaim, absenceContradicted } from "../../lib/engine/absence-claim";
import { VARIANCE } from "../../lib/engine/variance-names";
import { varianceSource } from "../../lib/engine/variance-source";

const ALL = { P: true, S: true, D: true, O: true };
const NONE = { P: false, S: false, D: false, O: false };
const flags = (on: string) => ({
  P: on.includes("P"),
  S: on.includes("S"),
  D: on.includes("D"),
  O: on.includes("O"),
});

describe("the table covers every name, and only real names", () => {
  it("has an entry for every variance the engine can emit", () => {
    // A new name with no entry silently falls to [] — never gateable — which is
    // safe but invisible. This makes adding one a deliberate decision.
    for (const name of Object.values(VARIANCE)) {
      expect(Object.hasOwn(ABSENCE_CLAIM, name), `missing: ${name}`).toBe(true);
    }
  });

  it("contains no key that is not a live variance name", () => {
    const live = new Set<string>(Object.values(VARIANCE));
    for (const key of Object.keys(ABSENCE_CLAIM)) {
      expect(live.has(key), `stale entry: ${key}`).toBe(true);
    }
  });

  it("never claims a source the name's own text does not accuse", () => {
    // The table is prose turned into flags, so it can be checked against the
    // prose — but only against the RIGHT HALF of it. Every name mentions each
    // source it involves, as a confirming book as often as an absent one, so
    // matching the whole string passes on anything: "Gate + Ops Confirm — No DT
    // Scan" contains "Gate" because the gate register CONFIRMED it.
    //
    // These names are all "<who confirms> — <what is missing>", so the claim
    // must be justified by the text after the em-dash. Adding "P" to GATE_ONLY —
    // the exact mutation this test exists to catch — passes a whole-string match
    // and fails this one.
    const mentions: Record<string, RegExp> = {
      P: /gate|floor/i,
      S: /ops|sheet|floor/i,
      D: /\bDT\b/i,
      O: /odoo/i,
    };
    for (const [name, claimed] of Object.entries(ABSENCE_CLAIM)) {
      if (claimed.length === 0) continue;
      const absencePart = name.split("—").slice(1).join("—");
      expect(absencePart, `${name} has no "— what is missing" half to check`).not.toBe("");
      for (const key of claimed) {
        expect(
          mentions[key].test(absencePart),
          `${name} claims ${key} is absent, but "${absencePart.trim()}" never names it`
        ).toBe(true);
      }
    }
  });

  it("that guard actually bites — the mutation it was written for fails it", () => {
    // Guards this test against itself. If someone reverts the em-dash split, a
    // whole-string match makes every one of these pass and the guard dies quiet.
    const mentions: Record<string, RegExp> = { P: /gate|floor/i, S: /ops|sheet|floor/i, D: /\bDT\b/i, O: /odoo/i };
    const absenceHalf = (n: string) => n.split("—").slice(1).join("—");
    // "Gate Register Only — No Ops / DT / Odoo Record" must not accuse the gate.
    expect(mentions.P.test(VARIANCE.GATE_ONLY)).toBe(true); // whole string: useless
    expect(mentions.P.test(absenceHalf(VARIANCE.GATE_ONLY))).toBe(false); // absence half: catches it
    // Same for the other two of the family.
    expect(mentions.S.test(absenceHalf(VARIANCE.SHEET_ONLY))).toBe(false);
    expect(mentions.D.test(absenceHalf(VARIANCE.DT_ONLY))).toBe(false);
  });

  it("returns nothing for a name nobody has reasoned about", () => {
    expect(absenceClaim("Some Future Variance Nobody Mapped")).toEqual([]);
    expect(absenceContradicted("Some Future Variance Nobody Mapped", ALL, ALL)).toBe(false);
  });
});

describe("the tautology this module exists to prevent", () => {
  // For each of these, varianceSource() names a source that was PRESENT when the
  // row was raised. Gating on it would retire the row the instant it was written.
  const TAUTOLOGICAL: [string, "P" | "S" | "D" | "O"][] = [
    [VARIANCE.GATE_ONLY, "P"],
    [VARIANCE.SHEET_ONLY, "S"],
    [VARIANCE.DT_ONLY, "D"],
    [VARIANCE.ODOO_ONLY, "O"],
    [VARIANCE.ODOO_ONLY_TODAY, "O"],
    [VARIANCE.GATE_OPS_ODOO_NO_DT, "O"],
    [VARIANCE.GATE_ODOO_NO_OPS_DT, "P"],
  ];

  it("never puts the source varianceSource() blames into the absence set", () => {
    for (const [name, presentAtEmit] of TAUTOLOGICAL) {
      expect(absenceClaim(name), name).not.toContain(presentAtEmit);
    }
  });

  it("declines to retire when only the already-present source is confirmed", () => {
    // The exact shape of the wrong fix: "Gate Register Only" with the gate
    // register still the only book holding it. Nothing has changed.
    expect(absenceContradicted(VARIANCE.GATE_ONLY, ALL, flags("P"))).toBe(false);
    expect(absenceContradicted(VARIANCE.SHEET_ONLY, ALL, flags("S"))).toBe(false);
    expect(absenceContradicted(VARIANCE.DT_ONLY, ALL, flags("D"))).toBe(false);
  });

  it("disagrees with varianceSource on the family where it matters", () => {
    // Documents the divergence rather than asserting one is 'right': they
    // answer different questions, and a future reader must not collapse them.
    expect(varianceSource(VARIANCE.GATE_ONLY)).toBe("Physical");
    expect(absenceClaim(VARIANCE.GATE_ONLY)).toEqual(["S", "D", "O"]);
  });
});

describe("what actually retires a row", () => {
  it("retires only when EVERY accused book now has the unit", () => {
    // Gate Register Only accuses three. Two is not enough — the row's name is
    // wrong now, but a variance still exists and re-classification is a
    // different job from retirement.
    expect(absenceContradicted(VARIANCE.GATE_ONLY, ALL, flags("PSD"))).toBe(false);
    expect(absenceContradicted(VARIANCE.GATE_ONLY, ALL, flags("PSDO"))).toBe(true);
  });

  it("retires the Delhi case: Odoo posted after the run that accused it", () => {
    // 41 REAL rows, 2026-08-09. Stored present --D-, and every one of the 41
    // was later found posted in Odoo on the business date itself.
    expect(absenceClaim(VARIANCE.FLOOR_DT_NOT_ODOO)).toEqual(["O"]);
    expect(absenceContradicted(VARIANCE.FLOOR_DT_NOT_ODOO, ALL, flags("SDO"))).toBe(true);
  });

  it("ignores a book that never filed when the row was raised", () => {
    // Rung 5 fires "Ops Sheet Only — No Gate / DT / Odoo Record" on rep.D &&
    // rep.O alone. On a day the guard never filed, the words "No Gate" assert
    // nothing about the guard — and the guard can never be confirmed present
    // either, so testing it would strand the row behind a condition it was
    // never judged against.
    const guardNeverFiled = { P: false, S: true, D: true, O: true };
    expect(absenceContradicted(VARIANCE.SHEET_ONLY, guardNeverFiled, flags("SDO"))).toBe(true);
    // …and with the guard reporting, it is held to the full claim.
    expect(absenceContradicted(VARIANCE.SHEET_ONLY, ALL, flags("SDO"))).toBe(false);
  });

  it("refuses when NO accused book reported — vacuous is not true", () => {
    // Every accused source absent from the run that raised the row leaves no
    // testable claim. That must read as "cannot retire", never as "trivially
    // satisfied", which is what an unguarded .every() over an empty list gives.
    const nothingFiled = { P: false, S: false, D: false, O: true };
    expect(absenceContradicted(VARIANCE.GATE_OPS_NO_DT_ODOO, nothingFiled, ALL)).toBe(true);
    const onlyOdooAccusedAndItNeverFiled = { P: true, S: true, D: true, O: false };
    expect(
      absenceContradicted(VARIANCE.FLOOR_DT_NOT_ODOO, onlyOdooAccusedAndItNeverFiled, ALL)
    ).toBe(false);
  });

  it("never retires a name that makes no absence claim", () => {
    // Nine names, 2,285 of 5,025 open rows — 45.5%. All of them would retire on a
    // vacuous .every(), and none of them should.
    const NON_GATEABLE = [
      VARIANCE.WRONG_SCAN,
      VARIANCE.REPLACEMENT_CONFIRM,
      VARIANCE.FAILED_DELIVERY,
      VARIANCE.SHEET_NOT_DONE_BUT_POSTED,
      VARIANCE.ADJACENT_DAY,
      VARIANCE.ODOO_POSTED_NEXT_DAY,
      VARIANCE.ODOO_POSTED_LATE,
      VARIANCE.FIELD_MISMATCH,
      VARIANCE.DUPLICATE,
    ];
    for (const name of NON_GATEABLE) {
      expect(absenceClaim(name), name).toEqual([]);
      expect(absenceContradicted(name, ALL, ALL), name).toBe(false);
    }
  });

  it("retires nothing when the ledger has no record of the unit", () => {
    // A unit that vanished from this run entirely is the ABSENCE case, and
    // absence is what the full-coverage branch exists to judge. This gate must
    // stay silent on it rather than reading "not present" as "still missing,
    // therefore fine to close".
    for (const name of Object.values(VARIANCE)) {
      expect(absenceContradicted(name, ALL, NONE), name).toBe(false);
    }
  });
});
