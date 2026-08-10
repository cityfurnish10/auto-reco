// Settling the part of the queue nobody will ever work.
//
// THE PROBLEM, measured on the live database 2026-08-10.
//
//   17,895 variance rows stood at status='open'.
//   13,492 of them (75%) had a business_date older than the oldest day
//          source_rows still retains, so no re-run can ever look at them again.
//    4,079 of them carried a variance name the system itself labels tier 3 —
//          "nothing to do" — chiefly "All Sources Agree — Barcode Text Differs"
//          (2,276) and "Odoo Entry Made Late — Posted Next Day" (1,803).
//
// Nothing in the system closes either group. `prune_expired` only deletes rows
// that are already closed; `resolveStaleOpenVariances` only runs when a date is
// reconciled again, which for a pruned date can no longer happen. So the count
// could only ever grow, and it did — which is exactly why the queue reads as
// hundreds of unresolved problems a day when the floor's own reconciliation
// finds a handful.
//
// WHAT THIS DOES. One daily sweep, two honest reasons, both recorded in
// closure_reason so every row stays one filter away:
//
//   AGED_OUT      the evidence is gone. Not "resolved" — unverifiable. Saying
//                 so is the accurate claim; leaving it open implies somebody
//                 can still act on it, and nobody can.
//   NO_ACTION     the engine's own label for the row is tier 3, "None." These
//                 are data-quality observations (a barcode spelled two ways, an
//                 Odoo entry posted a day late) that were never work.
//
// WHAT IT WILL NOT TOUCH, and why each guard is load-bearing:
//
//   * Any row a human has moved off `open`. in_progress, pending_approval and
//     closed are all somebody's decision and are never overwritten.
//   * Any date the re-check sweep can still reach. The cutoff is the EARLIER of
//     (the oldest retained source_rows date) and (today − MIN_AGE_DAYS), so a
//     row is only settled once BOTH "the evidence is gone" and "the sweep has
//     stopped visiting this date" are true. Migration 0018 re-runs D-2 … D-7;
//     MIN_AGE_DAYS is 8.
//   * Anything at all when source_rows is empty. A fresh or half-restored
//     database must not be read as "every date has expired".
//
// It writes status/closed_at/closed_by/closure_reason only — the four columns
// upsertVariances deliberately omits — so a later re-emit of the same natural
// key refreshes the engine's detail without reopening the row, and this sweep
// cannot fight the engine for the same field.

import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays } from "../engine/dates";
import { labelFor } from "../ui/variance-labels";

type DB = SupabaseClient;

/**
 * The evidence expired — this row can never be re-evaluated.
 *
 * Deliberately NOT one of the human `ClosureReason` values: those are choices
 * somebody made in a dialog, and mixing a machine's "we ran out of evidence"
 * into that list would put it in the dropdown and make the Pending List and the
 * closure analytics read as though a person had judged these.
 */
export const AGED_OUT_REASON = "Aged out — source data expired";

/** The engine's own label for the row is "nothing to do". */
export const NO_ACTION_REASON = "No action needed — information only";

/** Every reason this module writes. Read by the UI so both render as machine-set. */
export const SWEEP_REASONS: readonly string[] = [AGED_OUT_REASON, NO_ACTION_REASON];

/**
 * Days a row must be old before the sweep may touch it, whatever retention says.
 *
 * The pg_cron re-check (migration 0018) re-runs D-2 … D-7, and a row it can
 * still re-run is a row that can still clear on its own. Eight is one clear day
 * past the last date that sweep visits.
 */
export const MIN_AGE_DAYS = 8;

export interface SettleResult {
  /** The business date the sweep settled BELOW (exclusive). Null = it did nothing. */
  cutoff: string | null;
  agedOut: number;
  noAction: number;
  /** Why nothing happened, when nothing happened. */
  skipped?: string;
  /** Rows examined. */
  scanned: number;
  byCity: Record<string, number>;
}

interface Row {
  id: string;
  city: string;
  business_date: string;
  direction: string | null;
  variance_name: string;
  bucket: string | null;
  job_type: string | null;
  note: string | null;
}

/** The oldest business_date source_rows still holds, or null when it holds none. */
async function retentionFloor(db: DB): Promise<string | null> {
  const { data, error } = await db
    .from("source_rows")
    .select("business_date")
    .order("business_date", { ascending: true })
    .limit(1);
  if (error) throw new Error(`settle: source_rows probe failed: ${error.message}`);
  const first = (data ?? [])[0] as { business_date?: string } | undefined;
  return first?.business_date ?? null;
}

/**
 * @param opts.today The IST business date the sweep is running on — supplied by
 *   the caller (lastClosedBusinessDate), never read from the server clock here,
 *   so a test can pin it and the cron and the route cannot disagree.
 */
export async function settleUnactionableVariances(
  db: DB,
  opts: { today: string; dryRun?: boolean }
): Promise<SettleResult> {
  const empty: SettleResult = {
    cutoff: null,
    agedOut: 0,
    noAction: 0,
    scanned: 0,
    byCity: {},
  };

  const floor = await retentionFloor(db);
  if (!floor) {
    // No raw rows at all. Could be a fresh database, a restore in progress, or
    // a prune that over-ran. Any of those would make this sweep close the whole
    // table, so it declines rather than guesses.
    return { ...empty, skipped: "source_rows is empty — cannot tell which dates expired" };
  }

  const ageFloor = addDays(opts.today, -MIN_AGE_DAYS);
  // Both conditions must hold, so the cutoff is the EARLIER of the two.
  const cutoff = floor < ageFloor ? floor : ageFloor;

  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("variances")
      .select("id, city, business_date, direction, variance_name, bucket, job_type, note")
      .eq("status", "open")
      .lt("business_date", cutoff)
      // Deterministic order — an unordered .range() can repeat or skip rows,
      // and a row skipped here simply stays open forever.
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`settle: select failed: ${error.message}`);
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }

  const byCity: Record<string, number> = {};
  const agedOutIds: string[] = [];
  const noActionIds: string[] = [];
  for (const r of rows) {
    byCity[r.city] = (byCity[r.city] ?? 0) + 1;
    // The same label the digest and both dashboards read, with the same context
    // fields — so a row the owner sees as "For information" on screen is settled
    // here for exactly that reason, and never for a different one.
    const label = labelFor(r.variance_name, {
      direction: (r.direction as "IN" | "OUT" | "CROSS" | null) ?? null,
      jobType: r.job_type,
      bucket: (r.bucket as "REAL" | "INFO" | null) ?? null,
      note: r.note,
    });
    if (label.tier === 3) noActionIds.push(r.id);
    else agedOutIds.push(r.id);
  }

  const result: SettleResult = {
    cutoff,
    agedOut: agedOutIds.length,
    noAction: noActionIds.length,
    scanned: rows.length,
    byCity,
  };
  if (opts.dryRun) return result;

  const now = new Date().toISOString();
  // Chunked: a single .in() of 13,000 uuids is a URL no PostgREST will accept.
  const CHUNK = 400;
  const apply = async (ids: string[], reason: string) => {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { error } = await db
        .from("variances")
        .update({
          status: "closed",
          closed_at: now,
          // NULL, and that is the record: no person closed these. closed_by is
          // a nullable FK to app_users, so this is legal and readable — a row
          // with a closure reason and no closer was settled by the system.
          closed_by: null,
          closure_reason: reason,
        })
        .in("id", ids.slice(i, i + CHUNK))
        // Re-assert the status: between the read above and this write a manager
        // may have flagged or closed one of these, and their decision wins.
        .eq("status", "open");
      if (error) throw new Error(`settle: update failed: ${error.message}`);
    }
  };
  await apply(agedOutIds, AGED_OUT_REASON);
  await apply(noActionIds, NO_ACTION_REASON);

  return result;
}
