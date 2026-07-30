// What changed between two runs of one business date.
//
// PURE. Both sides are unit-key SETS read from run_city_snapshots, which is what
// makes this a different function from compareToSnapshot in
// lib/email/followup/compare.ts rather than a second call site of it:
//
//   * That one is COUNT-vs-SET — X is the integer snapshot.overall.flagged, Y is
//     a set size. So `closed = flagged − stillOpen` can go negative, needs the
//     moreThanReported branch, and clamps per-city closed at Math.max(0, …).
//     Here both sides are sets, so cleared and newlyRaised are non-negative by
//     construction, there is no clamp, and per-city figures sum to the overall
//     EXACTLY — the property that page exists to surface.
//
//   * Pass A cannot be read live. variances is upserted on its natural key with
//     run_id re-stamped, and superseded rows are hard-DELETEd, so run A's state is
//     already overwritten. Snapshot-vs-snapshot is a different signature, not a
//     different caller.
//
//   * "Still open" is not this page's question. The email asks "has anyone dealt
//     with this"; the analyser asks "did the engine stop seeing the problem", and
//     must report human action and system self-resolution as separate columns.
//
// What IS shared, and must stay shared: unitKeyOf (the matching rule) and
// classifyRows (what counts as flagged).

import { unitKeyOf } from "../email/followup/snapshot";
import type { FoldedPass } from "./snapshot";
import type { Comparability } from "./coverage";

/** Why an item that was flagged at A is no longer flagged at B. */
export type ClearedReason = "human-closed" | "engine-cleared" | "no-longer-flagged";

export interface ClearedAttribution {
  /** Someone settled it on the dashboard. */
  humanClosed: number;
  /** The row survives at tier 3 — a late entry filled the gap. */
  engineCleared: number;
  /**
   * The unit produced no row at all in B.
   *
   * Deliberately NOT called "superseded". Superseded rows are hard-DELETEd with
   * no tombstone (lib/db/persist.ts), so three outcomes are indistinguishable
   * inside this bucket: genuinely clean now; superseded and its replacement later
   * cleared; superseded twice with nothing left. Reporting a `superseded` count
   * would be a number nobody can stand behind.
   *
   * The one supersede that IS visible is the one whose replacement is still
   * flagged — and that unit correctly reports as stillOpen, because the unit is
   * still broken. That is a direct consequence of matching on the unit.
   */
  noLongerFlagged: number;
}

export interface CityDelta {
  city: string;
  flaggedA: number;
  flaggedB: number;
  stillOpen: number;
  cleared: number;
  newlyRaised: number;
}

export interface PassDelta {
  date: string;
  flaggedA: number;
  flaggedB: number;
  stillOpen: number;
  cleared: number;
  newlyRaised: number;
  attribution: ClearedAttribution;
  cities: CityDelta[];
  /** Keys were capped or pruned on one side — item-level claims are unsafe. */
  keysUnknown: boolean;
}

/**
 * The wire shape, where every figure the coverage guard blocked is `null`.
 *
 * A SEPARATE type from PassDelta, not the same one with optional fields, because
 * that is what makes it impossible to hand a component a suppressed figure as 0.
 * `null` renders as an em dash and means "we cannot say"; `0` means "we measured
 * none". Conflating them is how a page reports a source outage as progress.
 */
export interface CityDeltaOut {
  city: string;
  flaggedA: number;
  flaggedB: number;
  stillOpen: number | null;
  cleared: number | null;
  newlyRaised: number | null;
  /** Suppression reason for this city, straight from the guard. */
  verdict: string;
  note: string | null;
  restDay: boolean;
  movementsA: number | null;
  movementsB: number | null;
}

export interface PassDeltaOut {
  date: string;
  /** Each run's OWN finding. Readable even when the pair is incomparable. */
  flaggedA: number;
  flaggedB: number;
  stillOpen: number | null;
  cleared: number | null;
  newlyRaised: number | null;
  /** null when `cleared` itself is suppressed — the split cannot outlive its total. */
  attribution: ClearedAttribution | null;
  cities: CityDeltaOut[];
  keysUnknown: boolean;
}

const cityOfUnit = (unit: string) => unit.split("|")[0] ?? "";

/**
 * The three sets.
 *
 *   stillOpen   = A.flagged ∩ B.flagged
 *   cleared     = A.flagged \ B.flagged
 *   newlyRaised = B.flagged \ A.flagged
 *
 * Matching on the UNIT (city|direction|barcode) via unitKeyOf, never the full key.
 * resolveStaleOpenVariances DELETEs a row when the same (direction, barcode)
 * re-fires under a different name, and the replacement carries a fresh identity —
 * so full-key matching would report a still-broken unit as cleared AND as newly
 * raised. An error in the flattering direction.
 */
export function diffPasses(a: FoldedPass, b: FoldedPass): PassDelta {
  const stillOpenUnits: string[] = [];
  const clearedUnits: string[] = [];
  const newlyRaisedUnits: string[] = [];

  for (const unit of a.flaggedUnits) {
    if (b.flaggedUnits.has(unit)) stillOpenUnits.push(unit);
    else clearedUnits.push(unit);
  }
  for (const unit of b.flaggedUnits) {
    if (!a.flaggedUnits.has(unit)) newlyRaisedUnits.push(unit);
  }

  const attribution = attributeCleared(clearedUnits, b);

  // Per city, from the SAME sets as the overall — so the columns sum exactly.
  const cities = new Map<string, CityDelta>();
  const row = (city: string) =>
    cities.get(city) ??
    (cities.set(city, {
      city,
      flaggedA: 0,
      flaggedB: 0,
      stillOpen: 0,
      cleared: 0,
      newlyRaised: 0,
    }),
    cities.get(city)!);

  for (const unit of a.flaggedUnits) row(cityOfUnit(unit)).flaggedA++;
  for (const unit of b.flaggedUnits) row(cityOfUnit(unit)).flaggedB++;
  for (const unit of stillOpenUnits) row(cityOfUnit(unit)).stillOpen++;
  for (const unit of clearedUnits) row(cityOfUnit(unit)).cleared++;
  for (const unit of newlyRaisedUnits) row(cityOfUnit(unit)).newlyRaised++;
  // Cities either run touched but which flagged nothing still belong in the table.
  for (const city of new Set([...a.cities.keys(), ...b.cities.keys()])) row(city);

  return {
    date: a.date,
    flaggedA: a.flaggedUnits.size,
    flaggedB: b.flaggedUnits.size,
    stillOpen: stillOpenUnits.length,
    cleared: clearedUnits.length,
    newlyRaised: newlyRaisedUnits.length,
    attribution,
    cities: [...cities.values()].sort((x, y) => x.city.localeCompare(y.city)),
    keysUnknown: a.keysUnavailable || b.keysUnavailable,
  };
}

/**
 * Why each cleared unit cleared, human-first.
 *
 * Precedence matches isStillOpen's own asymmetry (`!== 'closed'`, not
 * `=== 'open'`): a closed row is a decided row, whatever the engine later thought
 * of it. Exhaustive by construction — the residual is named, not dropped.
 */
export function attributeCleared(
  clearedUnits: string[],
  b: FoldedPass,
  /** Units closed by a person, from live variances. Empty when unknown. */
  humanClosedUnits: Set<string> = new Set()
): ClearedAttribution {
  let humanClosed = 0;
  let engineCleared = 0;
  let noLongerFlagged = 0;
  for (const unit of clearedUnits) {
    if (humanClosedUnits.has(unit)) humanClosed++;
    else if (b.tier3Units.has(unit)) engineCleared++;
    else noLongerFlagged++;
  }
  return { humanClosed, engineCleared, noLongerFlagged };
}

export function reasonFor(
  unit: string,
  b: FoldedPass,
  humanClosedUnits: Set<string>
): ClearedReason {
  if (humanClosedUnits.has(unit)) return "human-closed";
  if (b.tier3Units.has(unit)) return "engine-cleared";
  return "no-longer-flagged";
}

/**
 * Blank every figure the coverage guard cannot stand behind.
 *
 * Done HERE and not in a component, so there is exactly one place that decides
 * whether a number is publishable. `null` renders as an em dash; `0` renders as
 * zero. A suppressed count must never arrive at the UI as 0.
 */
export function suppressUntrustworthy(delta: PassDelta, guard: Comparability): PassDeltaOut {
  const perCity = new Map(guard.perCity.map((c) => [c.city, c]));
  const clearedOk = guard.clearedTrustworthy;
  const newOk = guard.newlyRaisedTrustworthy;

  return {
    date: delta.date,
    // flaggedA/flaggedB are each ONE run's own finding and stay readable even when
    // the pair cannot be compared — that is the "two independent totals" fallback.
    flaggedA: delta.flaggedA,
    flaggedB: delta.flaggedB,
    stillOpen: clearedOk ? delta.stillOpen : null,
    cleared: clearedOk ? delta.cleared : null,
    newlyRaised: newOk ? delta.newlyRaised : null,
    // The split cannot outlive its total: publishing "38 closed by your team" when
    // `cleared` itself is suppressed would restore by the back door exactly the
    // claim the guard just refused.
    attribution: clearedOk ? delta.attribution : null,
    cities: delta.cities.map((row) => {
      const c = perCity.get(row.city);
      const cOk = c?.clearedTrustworthy ?? false;
      const nOk = c?.newlyRaisedTrustworthy ?? false;
      return {
        city: row.city,
        flaggedA: row.flaggedA,
        flaggedB: row.flaggedB,
        stillOpen: cOk ? row.stillOpen : null,
        cleared: cOk ? row.cleared : null,
        newlyRaised: nOk ? row.newlyRaised : null,
        verdict: c?.verdict ?? "unrecorded",
        note: c?.note ?? null,
        restDay: c?.restDay ?? false,
        movementsA: c?.movementsA ?? null,
        movementsB: c?.movementsB ?? null,
      };
    }),
    keysUnknown: delta.keysUnknown,
  };
}

/** The unit keys behind one delta cell, for the drill-down endpoint. */
export function unitsOf(
  a: FoldedPass,
  b: FoldedPass,
  klass: "cleared" | "still-open" | "newly-raised"
): string[] {
  const out: string[] = [];
  if (klass === "newly-raised") {
    for (const u of b.flaggedUnits) if (!a.flaggedUnits.has(u)) out.push(u);
  } else {
    const want = klass === "still-open";
    for (const u of a.flaggedUnits) if (b.flaggedUnits.has(u) === want) out.push(u);
  }
  return out.sort();
}

export { unitKeyOf };
