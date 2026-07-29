// Reading the follow-up's inputs: the snapshot it was queued against, the rows
// open now, and whether the date has actually been re-checked yet.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isCityOff } from "../../engine/schedule";
import type { City } from "../../sample-data";
import { parseTotalsSnapshot, type TotalsSnapshot } from "./snapshot";
import type { CurrentRow } from "./compare";

/** The snapshot pinned to this queue row, or null if it cannot be trusted. */
export async function loadSnapshot(
  db: SupabaseClient,
  emailLogId: string | null
): Promise<TotalsSnapshot | null> {
  if (!emailLogId) return null;
  const { data, error } = await db
    .from("email_logs")
    .select("totals")
    .eq("id", emailLogId)
    .maybeSingle();
  if (error) return null;
  return parseTotalsSnapshot((data as { totals?: unknown } | null)?.totals);
}

/**
 * Every open row for a date, from the LATEST run.
 *
 * Requires a run id and returns null without one. buildDigestFromDb tolerates a
 * missing run and reads unfiltered, which for a follow-up would silently merge
 * every re-check pass's rows for the date — the same class of double-count the
 * digest was already burned by.
 */
export async function readCurrentRows(
  db: SupabaseClient,
  businessDate: string
): Promise<CurrentRow[] | null> {
  const { data: runs } = await db
    .from("reconciliation_runs")
    .select("id")
    .eq("business_date", businessDate)
    .in("status", ["success", "partial"])
    .order("created_at", { ascending: false })
    .limit(1);
  const runId = (runs?.[0] as { id?: string } | undefined)?.id;
  if (!runId) return null;

  const rows: CurrentRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("variances")
      .select("city,direction,barcode,variance_name,job_type,bucket,note,status")
      .eq("run_id", runId)
      // Deterministic order — an unordered .range() can repeat or skip rows.
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`readCurrentRows: ${error.message}`);
    rows.push(...((data ?? []) as unknown as CurrentRow[]));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

export interface RunFreshness {
  fresh: boolean;
  /** When the date was last completely reconciled, for the stale banner. */
  lastCompletedAt: string | null;
}

/**
 * Has the date been re-checked since the digest went out?
 *
 * `completed_at`, never `created_at`: createRun stamps created_at at the START,
 * so a run killed by the 60s ceiling keeps a null completed_at forever. One such
 * row is already stranded in production. Testing completion is what makes this
 * predicate immune to that.
 */
export function isRerunFresh(
  runs: { status: string; completed_at: string | null }[],
  sinceIso: string
): RunFreshness {
  const done = runs
    .filter((r) => (r.status === "success" || r.status === "partial") && r.completed_at)
    .sort((a, b) => (a.completed_at! < b.completed_at! ? 1 : -1));
  const last = done[0]?.completed_at ?? null;
  return { fresh: !!last && Date.parse(last) > Date.parse(sinceIso), lastCompletedAt: last };
}

export async function checkRerun(
  db: SupabaseClient,
  businessDate: string,
  sinceIso: string
): Promise<RunFreshness> {
  const { data } = await db
    .from("reconciliation_runs")
    .select("status, completed_at")
    .eq("business_date", businessDate)
    .order("created_at", { ascending: false })
    .limit(20);
  return isRerunFresh((data ?? []) as { status: string; completed_at: string | null }[], sinceIso);
}

/** Cities whose warehouse was shut on the reported date. */
export function restDayCities(businessDate: string, cities: string[]): string[] {
  return cities.filter((c) => isCityOff(c as City, businessDate));
}
