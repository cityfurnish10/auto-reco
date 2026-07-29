// The runtime facts the model needs before it can answer anything: what today
// is, which day was last reconciled, and how far back the detail actually goes.
//
// Injected into the system prompt rather than exposed as a tool. A round trip
// costs 3-10s out of a 45s budget, and this is unavoidable context for every
// question, not an optional lookup.

import type { SupabaseClient } from "@supabase/supabase-js";
import { istDate } from "../reconcile/cron-dates";

export interface Anchor {
  /** Today in IST, which is the calendar the warehouse works to. */
  today: string;
  /** The most recent business date with a completed run, or null. */
  latestReconciled: string | null;
  /**
   * The oldest business date for which per-system detail still exists.
   *
   * READ FROM THE DATA, never computed from the 7-day retention constant. The
   * prune runs at the end of each reconcile, so the true floor drifts by a day,
   * and a constant would have the assistant promise detail that is already
   * gone — the exact failure the grounding contract exists to prevent.
   */
  detailHeldFrom: string | null;
}

let cached: { at: number; value: Anchor } | null = null;
const TTL_MS = 60_000;

export async function buildAnchor(sb: SupabaseClient, now = Date.now()): Promise<Anchor> {
  if (cached && now - cached.at < TTL_MS) return cached.value;

  const [runs, floor] = await Promise.all([
    sb
      .from("reconciliation_runs")
      .select("business_date")
      .in("status", ["success", "partial"])
      .order("business_date", { ascending: false })
      .limit(1),
    sb
      .from("source_rows")
      .select("business_date")
      .order("business_date", { ascending: true })
      .limit(1),
  ]);

  const value: Anchor = {
    today: istDate(),
    latestReconciled: (runs.data?.[0]?.business_date as string | undefined) ?? null,
    detailHeldFrom: (floor.data?.[0]?.business_date as string | undefined) ?? null,
  };
  cached = { at: now, value };
  return value;
}

/** Test seam. */
export function resetAnchorCache(): void {
  cached = null;
}
