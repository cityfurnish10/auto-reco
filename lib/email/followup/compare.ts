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

  const tierOf = (r: CurrentRow) =>
    labelFor(r.variance_name, {
      direction: (r.direction as "IN" | "OUT" | "CROSS" | null) ?? null,
      jobType: r.job_type,
      bucket: (r.bucket as "REAL" | "INFO" | null) ?? null,
      note: r.note,
    }).tier;

  // Only tier 1 and 2 are comparable: X is tier1 + tier2, and tier 3 is
  // "no action" — an item that fell to tier 3 has been resolved, not lost.
  const openFlagged = current.filter((r) => isStillOpen(r.status) && tierOf(r) < 3);

  // De-duplicated by unit: one unit can raise two rows (a ladder hit and a
  // duplicate-scan hit), and counting it twice would make Y exceed X for a
  // reason that is an artefact rather than a fact about stock.
  const openUnits = new Map<string, CurrentRow>();
  for (const r of openFlagged) {
    const k = `${r.city}|${r.direction ?? ""}|${r.barcode}`;
    if (!openUnits.has(k)) openUnits.set(k, r);
  }

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
      if (tierOf(r) === 1) stillOpenTier1++;
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
