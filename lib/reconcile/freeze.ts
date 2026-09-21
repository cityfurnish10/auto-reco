// What the Delivery Tracker said the FIRST time we asked, kept for good.
//
// WHY. The Tracker holds one row per job and rewrites it. A delivery attempted
// on the 18th and retried on the 20th is a row that read "Not Done" on the
// 18th and reads "Done" from the 20th onwards — same row, same id, the old
// value gone. Odoo appends, the ops sheet is a sheet, the gate register is
// ours; only the Tracker overwrites. So a re-run of an old date does not
// re-measure that day, it measures today's opinion of it, and a variance that
// was true on the 18th can quietly vanish (or appear) weeks later.
//
// Worked example, owner 21 Sep 2026: fridge APZQN422041372, ticket 1223452.
// The 18th's download showed Not Done; by the 21st the same row read Done and
// the job had moved to the 20th.
//
// WHAT THIS DOES. On a re-run, any Tracker unit the FIRST pull of that date
// recorded and today's pull no longer returns is carried forward, exactly as
// it was first seen, marked `frozen`. Nothing is overwritten and nothing new
// is invented: a unit today's pull DOES return keeps today's values, because a
// correction the Tracker made deliberately is still worth having.
//
// Tracker only, deliberately. The other three either append or are ours.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { City } from "../sample-data";
import type { SourceRow } from "../engine/types";
import { canonicalize } from "../engine/barcode";

type DB = SupabaseClient;

const PAGE = 1000;

/**
 * Add back the Tracker rows the first pull of `runDate` saw and this one did
 * not. Returns how many were carried forward, per city, and pushes one warning
 * when anything was.
 *
 * Best-effort: any failure leaves the fresh pull untouched. A frozen row is a
 * nicety; the run is not.
 */
export async function carryForwardFrozenDt(
  db: DB,
  runDate: string,
  currentRunId: string,
  rowsByCity: Record<City, SourceRow[]>,
  warnings: string[]
): Promise<number> {
  try {
    // The FIRST run of this date — the one that saw the day while it was the
    // day. A later re-run is just another opinion and must not become the
    // record.
    const runs = await db
      .from("reconciliation_runs")
      .select("id, created_at")
      .eq("business_date", runDate)
      .order("created_at", { ascending: true })
      .limit(2);
    const firstId = (runs.data ?? []).map((r) => r.id as string).find((id) => id !== currentRunId);
    if (!firstId) return 0;

    const stored: Record<string, unknown>[] = [];
    for (let from = 0; ; from += PAGE) {
      const page = await db
        .from("source_rows")
        .select("city, direction, barcode, barcode_canonical, raw")
        .eq("run_id", firstId)
        .eq("source", "DT")
        .range(from, from + PAGE - 1);
      if (page.error || !page.data?.length) break;
      stored.push(...(page.data as Record<string, unknown>[]));
      if (page.data.length < PAGE) break;
    }
    if (!stored.length) return 0;

    // What today's pull holds, per unit: city + direction + canonical barcode.
    const seen = new Set<string>();
    for (const [city, rows] of Object.entries(rowsByCity)) {
      for (const r of rows) {
        if (r.source !== "DT") continue;
        seen.add(`${city}|${r.direction}|${canonicalize(r.barcode)}`);
      }
    }

    let carried = 0;
    for (const row of stored) {
      const city = String(row.city ?? "") as City;
      const direction = String(row.direction ?? "");
      const canon = String(row.barcode_canonical ?? canonicalize(String(row.barcode ?? "")));
      if (!city || !direction || !canon) continue;
      if (seen.has(`${city}|${direction}|${canon}`)) continue;
      const raw = row.raw;
      if (!raw || typeof raw !== "object") continue;
      // `raw` is the SourceRow this connector emitted on the day — replayed as
      // it was, with a marker so anyone reading the feed can tell.
      const original = raw as SourceRow;
      if (original.source !== "DT") continue;
      (rowsByCity[city] ??= []).push({ ...original, frozen: true });
      seen.add(`${city}|${direction}|${canon}`);
      carried++;
    }

    if (carried > 0) {
      warnings.push(
        `${carried} tracker row${carried === 1 ? "" : "s"} carried forward from this date's first pull — the tracker has since rewritten or re-dated them`
      );
    }
    return carried;
  } catch {
    return 0;
  }
}
