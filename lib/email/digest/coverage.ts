// The four-way check: of the units that moved, how many appear in all four
// records, and where the missing one usually is.
//
// WHY THIS IS A SPLIT AND NOT A PASS RATE. Measured on 2026-07-29, the first
// date with all four sources live: Delhi 23 of 150 units reached all four (15%),
// Bangalore 39 of 131 (30%). The engine's verdict for that same day was NINE
// units at risk out of 503 — about 98% fine. A bare "23 of 150 passed" would
// tell a reader that 85% of stock is unaccounted for, which is false: plenty of
// legitimate movements are never expected in all four systems (Bangalore inward
// scored 0 of 64, every single one). So this reports the 4/3/2/1 distribution
// and names the source that is missing, which is a finding somebody can act on,
// rather than a ratio that reads as a catastrophe.
//
// WHICH DATE. Not necessarily the one the digest reports. Zero guard registers
// have ever been uploaded before their own date's 16:30 run — measured over all
// 33 rows of guard_uploads, see trends.ts:37-42 — so on the reported date
// present_p is false almost everywhere and a literal four-way check would score
// 0/N for every city, every day. latestFullyCoveredDate() therefore walks back
// to the newest date whose four sources all reported, and the section says which
// date it found. When register timing improves that answer moves forward on its
// own, with no code change.

import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays } from "../../engine/dates";

/** How far back to look for a date with all four sources. */
export const COVERAGE_LOOKBACK_DAYS = 7;

export type SourceKey = "P" | "S" | "D" | "O";

export const SOURCE_NAME: Record<SourceKey, string> = {
  P: "gate register",
  S: "ops sheet",
  D: "delivery app",
  O: "Odoo",
};

export interface CityCoverage {
  city: string;
  total: number;
  /** Units seen by exactly 4, 3, 2 and 1 source, in that order. */
  byCount: [number, number, number, number];
  /** How often each source was the absent one. */
  missing: Record<SourceKey, number>;
  /** Which sources reported for this city at all. */
  reported: Record<SourceKey, boolean>;
  inbound: { total: number; all4: number };
  outbound: { total: number; all4: number };
}

export interface FourWayCoverage {
  /** The business date actually measured — may be older than the reported day. */
  date: string;
  cities: CityCoverage[];
}

interface LedgerRow {
  city: string;
  direction: string | null;
  present_p: boolean | null;
  present_s: boolean | null;
  present_d: boolean | null;
  present_o: boolean | null;
  reported_p: boolean | null;
  reported_s: boolean | null;
  reported_d: boolean | null;
  reported_o: boolean | null;
  is_movement: boolean | null;
}

/** Did every source report for this city? Only then is a split meaningful. */
export function fullyReported(c: CityCoverage): boolean {
  return c.reported.P && c.reported.S && c.reported.D && c.reported.O;
}

/** Below this a leg is too small for its rate to mean anything. */
const MIN_LEG = 20;
/** A leg this bad, against a sibling this good, is a pattern not noise. */
const LEG_BAD = 0.05;
const LEG_GOOD = 0.25;

/**
 * One direction failing while the other passes — the finding a per-city total
 * hides completely.
 *
 * Measured on Bangalore: 29 Jul inward reached all four records on 0 of 64
 * units and outward on 39 of 67; 28 Jul, 1 of 60 against 41 of 74. The absent
 * source is the gate register in 54 of those 64. The city's overall split looks
 * merely mediocre; the truth is that one whole direction is unlogged.
 *
 * Both legs must clear MIN_LEG, so a warehouse with three inward movements
 * cannot manufacture a headline. Returns the facts only — which record is
 * missing is already in the caption, and WHY is not something this can know.
 */
export function directionSkew(
  c: CityCoverage
): { weak: "arriving" | "leaving"; weakAll4: number; weakTotal: number; strongAll4: number; strongTotal: number } | null {
  const { inbound: i, outbound: o } = c;
  if (i.total < MIN_LEG || o.total < MIN_LEG) return null;
  const ri = i.all4 / i.total;
  const ro = o.all4 / o.total;
  if (ri <= LEG_BAD && ro >= LEG_GOOD) {
    return { weak: "arriving", weakAll4: i.all4, weakTotal: i.total, strongAll4: o.all4, strongTotal: o.total };
  }
  if (ro <= LEG_BAD && ri >= LEG_GOOD) {
    return { weak: "leaving", weakAll4: o.all4, weakTotal: o.total, strongAll4: i.all4, strongTotal: i.total };
  }
  return null;
}

/** The source most often absent, or null when nothing is missing. */
export function topMissing(c: CityCoverage): { source: SourceKey; count: number } | null {
  const ranked = (Object.keys(c.missing) as SourceKey[])
    .map((source) => ({ source, count: c.missing[source] }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
  return ranked[0] && ranked[0].count > 0 ? ranked[0] : null;
}

/**
 * The newest business date on or before `upTo` where all four sources reported.
 *
 * Reads run_city_stats, which carries the reported_* flags per city per date
 * (migration 0012). Returns null when no date in the window qualifies — which is
 * the honest answer during the first week after a source outage, and the caller
 * must render that rather than an empty table.
 */
export async function latestFullyCoveredDate(
  db: SupabaseClient,
  upTo: string,
  lookbackDays: number = COVERAGE_LOOKBACK_DAYS
): Promise<string | null> {
  const from = addDays(upTo, -lookbackDays);
  const { data, error } = await db
    .from("run_city_stats")
    .select("business_date, reported_p, reported_s, reported_d, reported_o")
    .gte("business_date", from)
    .lte("business_date", upTo)
    .order("business_date", { ascending: false });
  // 42703/PGRST204: pre-0012 database with no reported_* columns. Say "no
  // covered date" rather than guessing that a missing column means true.
  if (error || !data) return null;

  for (const r of data) {
    if (r.reported_p && r.reported_s && r.reported_d && r.reported_o) {
      return r.business_date as string;
    }
  }
  return null;
}

/**
 * Fold the movement ledger for one date into the per-city split.
 *
 * Returns null when the ledger cannot be read at all (migration 0015 not
 * applied), which the caller renders by omitting the section entirely — an
 * absent claim beats an unevidenced one.
 */
export async function readFourWayCoverage(
  db: SupabaseClient,
  date: string
): Promise<FourWayCoverage | null> {
  const rows: LedgerRow[] = [];
  // Paginated: PostgREST silently caps an un-ranged select at 1000 rows, and a
  // busy day is comfortably over that. Ordered by id so pages cannot repeat or
  // skip — an unordered .range() is free to reshuffle between calls.
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("movement_events")
      .select(
        "city, direction, present_p, present_s, present_d, present_o, reported_p, reported_s, reported_d, reported_o, is_movement"
      )
      .eq("business_date", date)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) return null;
    rows.push(...((data ?? []) as LedgerRow[]));
    if (!data || data.length < 1000) break;
  }
  if (rows.length === 0) return null;

  const byCity = new Map<string, CityCoverage>();

  for (const r of rows) {
    // Adjacent-day Odoo postings are match TARGETS, not movements. Counting
    // them inflated Bangalore 2026-07-20 to 1,231 "movements" against a ~130-row
    // floor; the same skip guards /api/stats/summary and /api/stock/movements.
    if (!r.is_movement) continue;

    const c =
      byCity.get(r.city) ??
      ({
        city: r.city,
        total: 0,
        byCount: [0, 0, 0, 0],
        missing: { P: 0, S: 0, D: 0, O: 0 },
        // OR-ed across the city's rows: migration 0015 stores reported_* per
        // ROW precisely so a later partial re-run of run_city_stats cannot
        // rewrite them underneath. Any row that saw a source counts.
        reported: { P: false, S: false, D: false, O: false },
        inbound: { total: 0, all4: 0 },
        outbound: { total: 0, all4: 0 },
      } satisfies CityCoverage);

    const present: Record<SourceKey, boolean> = {
      P: !!r.present_p,
      S: !!r.present_s,
      D: !!r.present_d,
      O: !!r.present_o,
    };
    const seen = (["P", "S", "D", "O"] as SourceKey[]).filter((k) => present[k]).length;

    c.total++;
    // byCount[0] is "all four"; index 4 - seen. A row seen by nothing at all
    // cannot occur (is_movement requires at least one source) but is dropped
    // rather than trusted to be impossible.
    if (seen >= 1) c.byCount[4 - seen]++;
    for (const k of ["P", "S", "D", "O"] as SourceKey[]) {
      if (!present[k]) c.missing[k]++;
      if (r[`reported_${k.toLowerCase()}` as keyof LedgerRow]) c.reported[k] = true;
    }

    const leg = r.direction === "IN" ? c.inbound : c.outbound;
    leg.total++;
    if (seen === 4) leg.all4++;

    byCity.set(r.city, c);
  }

  if (byCity.size === 0) return null;
  return {
    date,
    cities: [...byCity.values()].sort((a, b) => b.total - a.total || a.city.localeCompare(b.city)),
  };
}
