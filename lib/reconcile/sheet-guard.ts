// Refuse to trust a truncated ops-sheet pull.
//
// THE FAILURE THIS EXISTS FOR, and it is asymmetric in the worst direction.
//
// The Sheets connector keeps the last ROW_BUFFER rows of each tab. That buffer
// was raised to 1500 precisely because a D-3 pull once found 20 of ~200 rows
// and caused a false variance flood — and the re-check pass now runs at exactly
// D-3.
//
// A partial truncation does not look like an outage. The pull still returns
// rows, so reported.S is TRUE, so fullCoverage can be TRUE, and
// resolveStaleOpenVariances then rewrites genuinely-open items to "Entry was
// made late — this gap had cleared". That is silent data loss dressed as a
// resolution, on a date whose digest already went out and whose follow-up is
// about to quote the result.
//
// So: compare what we just pulled against what the ORIGINAL run stored for the
// same date (migration 0012 persists sheet_in/sheet_out per city). Materially
// short means the sheet cannot be trusted for that city, and marking it
// unreported is fail-safe — the ladder stops blaming it for absences and the
// resolved-late branch stops firing.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { City } from "../sample-data";
import type { ReportedSources } from "../engine/types";

/**
 * Below this share of the previously-recorded rows, the pull is treated as
 * truncated. Generous on purpose: rows are legitimately edited and deleted
 * between runs, and a false alarm only costs one date's late-resolutions,
 * whereas a false resolution destroys an open item.
 */
export const SHEET_TRUNCATION_FLOOR = 0.8;

export interface SheetCheck {
  city: string;
  pulled: number;
  previously: number;
  truncated: boolean;
}

/** Pure: compare this pull against what was stored before. */
export function checkSheetCoverage(
  pulledByCity: Record<string, number>,
  storedByCity: Record<string, number>
): SheetCheck[] {
  const out: SheetCheck[] = [];
  for (const [city, previously] of Object.entries(storedByCity)) {
    // No prior figure means this is the date's first run — nothing to compare.
    if (!previously) continue;
    const pulled = pulledByCity[city] ?? 0;
    out.push({ city, pulled, previously, truncated: pulled < previously * SHEET_TRUNCATION_FLOOR });
  }
  return out;
}

/**
 * Read the ops-sheet row counts the original run recorded for this date, and
 * distrust SHEET for any city whose pull has come back materially short.
 *
 * Best-effort: if the stats cannot be read, nothing changes. This must never be
 * the reason a reconcile fails.
 */
export async function guardTruncatedSheet(
  db: SupabaseClient,
  runDate: string,
  rowsByCity: Record<City, { source: string }[]>,
  reportedByCity: Partial<Record<City, ReportedSources>>,
  warnings: string[]
): Promise<Partial<Record<City, ReportedSources>>> {
  const { data, error } = await db
    .from("run_city_stats")
    .select("city, sheet_in, sheet_out")
    .eq("business_date", runDate);
  // Absent columns (pre-0012) or any read failure: leave the run untouched.
  if (error || !data?.length) return reportedByCity;

  const stored: Record<string, number> = {};
  for (const r of data as { city: string; sheet_in: number | null; sheet_out: number | null }[]) {
    stored[r.city] = (r.sheet_in ?? 0) + (r.sheet_out ?? 0);
  }
  const pulled: Record<string, number> = {};
  for (const [city, rows] of Object.entries(rowsByCity)) {
    pulled[city] = rows.filter((r) => r.source === "SHEET").length;
  }

  const guarded = { ...reportedByCity };
  for (const check of checkSheetCoverage(pulled, stored)) {
    if (!check.truncated) continue;
    const rep = guarded[check.city as City];
    if (!rep?.S) continue; // already unreported — nothing to protect
    guarded[check.city as City] = { ...rep, S: false };
    warnings.push(
      `Ops sheet for ${check.city} pulled ${check.pulled} rows against ${check.previously} recorded earlier for ${runDate} — treating the sheet as not reported so a truncated pull cannot resolve open items.`
    );
  }
  return guarded;
}
