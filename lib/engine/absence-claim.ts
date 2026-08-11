// What each variance name claims is MISSING.
//
// This is not varianceSource(), and confusing the two is the trap this module
// exists to close. varianceSource answers "who should fix this" — for the
// *_ONLY family it names the one book that DID record the unit. A gate written
// as `present_<varianceSource(name)>` therefore tests a fact that was true the
// moment the row was created: measured on the live open queue it fires on
// roughly SEVEN IN TEN open rows (3,576 of 5,025 on 2026-08-11) and would
// retire almost the entire board. The correct gate fired on 55 of the same set.
// Both figures move as the queue turns over; the order of magnitude is the
// point, and it has held across every re-measurement.
//
// The question a resolution gate has to ask is the other one: which books did
// this row accuse of not having the unit, and do they have it now? That is a
// SET, not a scalar — "Gate Register Only" accuses three books at once, and a
// row is only resolved when every one of them has since filed.
//
// EMPTY MEANS NOT GATEABLE, and it is a deliberate value rather than an
// oversight. Nine names make no absence claim that presence flags can test: two
// are about a status conflict, two about raw spellings the ledger does not
// store, two about Odoo already holding the unit, one about a NEARBY day rather
// than this one, one about two rows inside a single source, and one about both
// legs being present. They cover a little under half the open queue (2,285 of
// 5,025 on 2026-08-11) and are handled elsewhere — mostly by the tier-3 "no
// action" sweep. Returning [] routes them to the old absence-based branch
// instead of quietly retiring them.
//
// Keyed by the VARIANCE constants rather than by string literal so a rename
// moves the table with the name, and covered by a test that fails the moment a
// new name is added to VARIANCE without an entry here.

import { VARIANCE } from "./variance-names";

/** The four books, in the order the dashboards show them. */
export type SourceKey = "P" | "S" | "D" | "O";

export const ABSENCE_CLAIM: Record<string, readonly SourceKey[]> = {
  // ── REAL ────────────────────────────────────────────────────────────────
  // A DT status, not an absence — the unit IS scanned, under the wrong barcode.
  [VARIANCE.WRONG_SCAN]: [],
  [VARIANCE.FLOOR_DT_NOT_ODOO]: ["O"],
  [VARIANCE.GATE_OPS_NO_DT_ODOO]: ["D", "O"],
  [VARIANCE.GATE_ONLY]: ["S", "D", "O"],
  [VARIANCE.SHEET_ONLY]: ["P", "D", "O"],
  [VARIANCE.PICKUP_ODOO_OPEN]: ["O"],
  [VARIANCE.DT_ONLY]: ["P", "S", "O"],
  // Both legs are present; what makes it a variance is the pairing.
  [VARIANCE.REPLACEMENT_CONFIRM]: [],
  // Built on NOT-DONE rows, so presence says nothing about it.
  [VARIANCE.FAILED_DELIVERY]: [],
  // A status contradiction between books that all hold the unit.
  [VARIANCE.SHEET_NOT_DONE_BUT_POSTED]: [],
  [VARIANCE.ODOO_ONLY_TODAY]: ["P", "S", "D"],

  // ── INFO ────────────────────────────────────────────────────────────────
  [VARIANCE.OPS_ODOO_NO_GATE]: ["P"],
  // The claim is about a NEARBY day, not this one — re-testing today's presence
  // would answer a different question than the one the row asked.
  [VARIANCE.ADJACENT_DAY]: [],
  [VARIANCE.ODOO_ONLY]: ["P", "S", "D"],
  // Odoo already has the unit; the row is about WHEN, and that cannot un-happen.
  [VARIANCE.ODOO_POSTED_NEXT_DAY]: [],
  [VARIANCE.ODOO_POSTED_LATE]: [],
  [VARIANCE.OPS_ODOO_NO_DT]: ["D"],
  [VARIANCE.DT_ODOO_NO_SHEET]: ["S"],
  [VARIANCE.GATE_OPS_ODOO_NO_DT]: ["D"],
  [VARIANCE.GATE_ODOO_NO_OPS_DT]: ["S", "D"],
  [VARIANCE.OPS_DT_ODOO_PENDING]: ["O"],
  // Every book has it; they spell it differently. Needs the per-source raw
  // spellings, which the ledger does not carry.
  [VARIANCE.FIELD_MISMATCH]: [],
  // Two rows inside ONE source. Presence is true either way.
  [VARIANCE.DUPLICATE]: [],
};

/**
 * The books this variance name says do not hold the unit.
 *
 * An UNKNOWN name returns [] — not a guess. A name this table has never seen is
 * one nobody has reasoned about, and inventing an absence set for it would
 * retire rows on a rule no one wrote. Empty routes it to the conservative path.
 */
export function absenceClaim(varianceName: string): readonly SourceKey[] {
  return ABSENCE_CLAIM[varianceName] ?? [];
}

/**
 * Does fresh evidence now contradict this row's accusation?
 *
 * `reported` is the row's OWN emit-time record of which books filed, and the
 * intersection with it is load-bearing rather than defensive. The ladder's rungs
 * are weaker than their names read: rung 5 fires "Ops Sheet Only — No Gate / DT
 * / Odoo Record" on `rep.D && rep.O` alone, so on a day the guard never filed
 * the words "No Gate" assert nothing about the guard — and the guard can never
 * be confirmed present either, which would strand the row forever behind a
 * condition it was never judged against.
 *
 * Requiring a NON-EMPTY intersection is the other half of that. A row whose
 * every accused book was absent from the run that raised it has no testable
 * claim left, and "no testable claim" must read as "cannot retire", never as
 * "vacuously true".
 */
export function absenceContradicted(
  varianceName: string,
  reported: { P: boolean; S: boolean; D: boolean; O: boolean },
  presentNow: { P: boolean; S: boolean; D: boolean; O: boolean }
): boolean {
  const claimed = absenceClaim(varianceName);
  if (claimed.length === 0) return false;
  const testable = claimed.filter((k) => reported[k]);
  if (testable.length === 0) return false;
  return testable.every((k) => presentNow[k]);
}
