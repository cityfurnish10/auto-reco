// X versus Y: what the email said, against what is still open two days later.
//
// PURE. It takes rows that have already been read, so every awkward case below
// is a unit test with no database.

import { labelFor } from "../../ui/variance-labels";
import { unitKeyOf, type TotalsSnapshot } from "./snapshot";

/**
 * The one definition of "still open", used by the follow-up and by the
 * scheduled-digest gate.
 *
 * `!== 'closed'`, NOT `=== 'open'`. X was built the same way
 * (lib/email/digest/build.ts filters `status !== "closed"`), and comparing an X
 * built one way against a Y built the other would make an item "resolve" the
 * moment a manager clicks start-work — the delta would measure clicks, not
 * stock. Two conflicting definitions already existed in this codebase; this is
 * the survivor.
 *
 * `pending_approval` counts as open on purpose: an admin can still reject it
 * back, so calling it resolved would declare a day clean on work nobody has
 * agreed with.
 */
export function isStillOpen(status: string | null | undefined): boolean {
  return status !== "closed";
}

export interface CurrentRow {
  city: string;
  direction: string | null;
  barcode: string;
  variance_name: string;
  job_type: string | null;
  bucket: string | null;
  note: string | null;
  status: string;
}

/** The unit a row belongs to — city|direction|barcode. */
export function unitKeyOfRow(r: Pick<CurrentRow, "city" | "direction" | "barcode">): string {
  return `${r.city}|${r.direction ?? ""}|${r.barcode}`;
}

export type UnitTier = 1 | 2 | 3;

export interface RowClassification {
  /** Open, tier 1 or 2 — the comparable population. One entry per unit. */
  flagged: Map<string, CurrentRow>;
  /** Open but tier 3: the engine has stopped asking for action on this unit. */
  tier3: Map<string, CurrentRow>;
  /** Settled by a person. Takes precedence over tier 3 — a decision outranks a downgrade. */
  closed: Map<string, CurrentRow>;
  /** The tier the winning row resolved to, keyed by unit. */
  tierOf: Map<string, UnitTier>;
}

/**
 * Sort variance rows into the three unit sets everything downstream compares.
 *
 * ONE definition, shared by the follow-up email and the Stock Analyser. If the
 * two decided independently which rows count as "flagged", the page and the inbox
 * would print different numbers for the same day — the exact failure
 * `isStillOpen` above records having already happened once in this codebase.
 *
 * Two rules that are easy to get wrong:
 *
 *   * DE-DUPLICATED BY UNIT. classifyViews can push a ladder hit AND a
 *     duplicate-scan hit for one unit, and counting both makes a set difference
 *     report a change in rows while calling it a change in stock.
 *
 *   * WORST TIER WINS within a unit. A unit carrying both a "Records to fix" and
 *     a "Stock at risk" row is stock at risk. This also keeps the email's tier
 *     split identical to what run_city_snapshots stored for the same run, so the
 *     two can be checked against each other.
 *
 * Precedence across the sets is flagged → closed → tier 3: an open actionable row
 * outranks everything, and a human decision outranks an engine downgrade.
 */
export function classifyRows(rows: CurrentRow[]): RowClassification {
  const tierOfRow = (r: CurrentRow): UnitTier =>
    labelFor(r.variance_name, {
      direction: (r.direction as "IN" | "OUT" | "CROSS" | null) ?? null,
      jobType: r.job_type,
      bucket: (r.bucket as "REAL" | "INFO" | null) ?? null,
      note: r.note,
    }).tier;

  const flagged = new Map<string, CurrentRow>();
  const tier3 = new Map<string, CurrentRow>();
  const closed = new Map<string, CurrentRow>();
  const tierOf = new Map<string, UnitTier>();

  for (const r of rows) {
    const k = unitKeyOfRow(r);
    const tier = tierOfRow(r);
    const open = isStillOpen(r.status);

    if (open && tier < 3) {
      const seen = tierOf.get(k);
      if (!flagged.has(k) || (seen !== undefined && tier < seen)) {
        flagged.set(k, r);
        tierOf.set(k, tier);
      }
      // Now flagged, so it can no longer be reported as settled or downgraded.
      closed.delete(k);
      tier3.delete(k);
      continue;
    }
    if (flagged.has(k)) continue;

    if (!open) {
      if (!closed.has(k)) closed.set(k, r);
      tier3.delete(k);
      if (!tierOf.has(k)) tierOf.set(k, tier);
      continue;
    }
    if (!closed.has(k) && !tier3.has(k)) {
      tier3.set(k, r);
      tierOf.set(k, tier);
    }
  }

  return { flagged, tier3, closed, tierOf };
}

export interface CityComparison {
  city: string;
  flagged: number;
  stillOpen: number;
  closed: number;
  newlyFlagged: number;
}

export interface FollowUpComparison {
  date: string;
  /** What the email printed. */
  flagged: number;
  /** Of those, still open now. */
  stillOpen: number;
  /** flagged − stillOpen. Never rendered when `moreThanReported`. */
  closed: number;
  stillOpenTier1: number;
  stillOpenTier2: number;
  /** Flagged for this date SINCE the email — late entries raising new gaps. */
  newlyFlagged: number;
  /**
   * True when more is open now than the email reported. Reopened items and one
   * unit raising two rows where it raised one both do this. The email then
   * prints no closed count, because it would be negative.
   */
  moreThanReported: boolean;
  cities: CityComparison[];
  /** Keys were capped, so "newly flagged" cannot be trusted and is suppressed. */
  newlyFlaggedUnknown: boolean;
}

/**
 * Compare a snapshot against the rows open now.
 *
 * Matching is on the UNIT (city|direction|barcode), never the full row key.
 * resolveStaleOpenVariances DELETEs a row when the same (direction, barcode)
 * re-fires under a different name, and the replacement carries a fresh
 * identity — so row-key matching would report a still-broken unit as newly
 * flagged, an error in the flattering direction.
 */
export function compareToSnapshot(
  snapshot: TotalsSnapshot,
  current: CurrentRow[]
): FollowUpComparison {
  const wasFlagged = new Set(snapshot.keys.map(unitKeyOf));
  const { flagged: openUnits, tierOf } = classifyRows(current);

  let stillOpen = 0;
  let newlyFlagged = 0;
  let stillOpenTier1 = 0;
  let stillOpenTier2 = 0;
  const perCity = new Map<string, CityComparison>();
  const cityOf = (city: string) =>
    perCity.get(city) ??
    (perCity.set(city, { city, flagged: 0, stillOpen: 0, closed: 0, newlyFlagged: 0 }),
    perCity.get(city)!);

  for (const [k, r] of openUnits) {
    const c = cityOf(r.city);
    if (wasFlagged.has(k)) {
      stillOpen++;
      c.stillOpen++;
      if (tierOf.get(k) === 1) stillOpenTier1++;
      else stillOpenTier2++;
    } else {
      newlyFlagged++;
      c.newlyFlagged++;
    }
  }

  for (const c of snapshot.cities) {
    const row = cityOf(c.city);
    row.flagged = c.flagged;
  }
  for (const row of perCity.values()) {
    row.closed = Math.max(0, row.flagged - row.stillOpen);
  }

  const flagged = snapshot.overall.flagged;
  const moreThanReported = stillOpen > flagged;

  return {
    date: snapshot.date,
    flagged,
    stillOpen,
    closed: flagged - stillOpen,
    stillOpenTier1,
    stillOpenTier2,
    newlyFlagged,
    moreThanReported,
    // Cities the snapshot knew about, in its order; a city that has vanished
    // from the current rows still belongs in the table with zeros.
    cities: snapshot.cities.map((c) => cityOf(c.city)),
    newlyFlaggedUnknown: snapshot.keysTruncated,
  };
}
