// What an email said, frozen at the moment it went on the wire.
//
// The follow-up's X is "the number the recipient is looking at in their inbox".
// It cannot be recomputed later: the re-check pass overwrites run_city_stats for
// the date, buildDigestFromDb returns current state by construction, and the
// archive keeps the figures only as prose. See migration 0016's header for the
// full argument. So it is written down once, by the code that rendered it.

import type { DigestData } from "../digest/types";

export const SNAPSHOT_VERSION = 1;

/**
 * How many flagged-row keys to store.
 *
 * ~55 bytes each, so 3000 is ~165 KB — comfortably inside a TOASTed jsonb, and
 * a busy day measures ~400. Past the cap `keysTruncated` is set and the
 * follow-up omits its "newly flagged" line rather than printing a number it
 * cannot stand behind.
 */
export const MAX_SNAPSHOT_KEYS = 3000;

export interface SnapshotCounts {
  movements: number;
  tier1: number;
  tier2: number;
  tier3: number;
  /** Every open item, tier 3 included — the digest's reconciling line. */
  open: number;
  /**
   * tier1 + tier2. STORED, not derived, so the follow-up can never define X
   * differently from the sender that produced it.
   */
  flagged: number;
}

export interface TotalsSnapshot {
  v: number;
  date: string;
  /** The wire moment, not the queue moment. */
  sentAt: string;
  overall: SnapshotCounts;
  cities: (SnapshotCounts & { city: string })[];
  /** Natural keys of the flagged rows: CITY|DIRECTION|BARCODE|VARIANCE_NAME. */
  keys: string[];
  keysTruncated: boolean;
}

const counts = (t: {
  movements: number;
  tier1: number;
  tier2: number;
  tier3: number;
  open: number;
}): SnapshotCounts => ({
  movements: t.movements,
  tier1: t.tier1,
  tier2: t.tier2,
  tier3: t.tier3,
  open: t.open,
  flagged: t.tier1 + t.tier2,
});

/** The natural key of a variance row, matching the table's unique constraint. */
export function flaggedKeyOf(r: {
  city: string;
  direction: string | null;
  barcode: string;
  variance_name: string;
}): string {
  return `${r.city}|${r.direction ?? ""}|${r.barcode}|${r.variance_name}`;
}

/**
 * The UNIT a key refers to, dropping the problem name.
 *
 * The comparison matches on this, not the full key. resolveStaleOpenVariances
 * DELETEs a row when the same (direction, barcode) re-fires under a different
 * name, and the replacement carries a fresh identity — so matching on the full
 * key would report a still-broken unit as newly flagged, which is an error in
 * the flattering direction.
 */
export function unitKeyOf(key: string): string {
  return key.split("|").slice(0, 3).join("|");
}

export function digestTotalsSnapshot(data: DigestData, sentAt: string): TotalsSnapshot {
  const keys = data.flaggedKeys ?? [];
  return {
    v: SNAPSHOT_VERSION,
    date: data.date,
    sentAt,
    overall: counts(data.totals),
    cities: data.cities.map((c) => ({ city: c.city, ...counts(c) })),
    keys: keys.slice(0, MAX_SNAPSHOT_KEYS),
    keysTruncated: keys.length > MAX_SNAPSHOT_KEYS,
  };
}

/**
 * Read a stored snapshot back.
 *
 * Returns null on ANY shape it does not recognise — an unknown version, a
 * missing field, the wrong type. A half-understood document must never become a
 * number in an email; skipping is the honest failure.
 */
export function parseTotalsSnapshot(raw: unknown): TotalsSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<TotalsSnapshot>;
  if (s.v !== SNAPSHOT_VERSION) return null;
  if (typeof s.date !== "string" || typeof s.sentAt !== "string") return null;
  if (!isCounts(s.overall) || !Array.isArray(s.cities) || !Array.isArray(s.keys)) return null;
  for (const c of s.cities) {
    if (!c || typeof (c as { city?: unknown }).city !== "string" || !isCounts(c)) return null;
  }
  if (s.keys.some((k) => typeof k !== "string")) return null;
  return {
    v: s.v,
    date: s.date,
    sentAt: s.sentAt,
    overall: s.overall,
    cities: s.cities,
    keys: s.keys,
    keysTruncated: s.keysTruncated === true,
  };
}

function isCounts(v: unknown): v is SnapshotCounts {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (["movements", "tier1", "tier2", "tier3", "open", "flagged"] as const).every(
    (k) => typeof c[k] === "number" && Number.isFinite(c[k] as number)
  );
}
