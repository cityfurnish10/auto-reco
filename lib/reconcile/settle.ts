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
  /**
   * The date below which a row counts as unverifiable (exclusive).
   *
   * Null once nothing is pruned — see the two-cutoff note in the sweep. That is
   * the healthy state, not a failure: no evidence expires, so nothing is
   * unverifiable.
   */
  cutoff: string | null;
  /** The date below which a tier-3 row is settled (exclusive). Always set. */
  noActionCutoff: string;
  agedOut: number;
  noAction: number;
  /**
   * Rows old enough to look at, left open because they are actionable AND
   * their evidence is still on file. Reported so "the sweep did nothing" and
   * "the sweep looked and correctly declined" are never the same number.
   */
  leftOpen: number;
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
  // TWO CUTOFFS, BECAUSE THE TWO REASONS REST ON DIFFERENT FACTS (0022).
  //
  // Until 2026-08-10 there was one cutoff, because both reasons happened to be
  // bounded by the same thing: source_rows was pruned at seven days, so "old
  // enough that the re-check sweep has stopped visiting it" and "old enough
  // that the evidence is gone" moved together.
  //
  // Migration 0022 stops pruning, and they come apart. retentionFloor() now
  // returns the oldest date ever stored and never advances, so a single cutoff
  // would collapse to that date and quietly switch the WHOLE sweep off —
  // including the tier-3 branch, which has nothing to do with retention and
  // must keep running.
  //
  //   noActionCutoff  age only. A row the engine itself labels "None." is not
  //                   work, whatever evidence still exists behind it.
  //   agedOutCutoff   age AND the evidence being gone. With nothing pruned this
  //                   stops firing on its own, which is the correct outcome
  //                   rather than a special case: nothing expires any more, so
  //                   nothing can be unverifiable. It stays in the code because
  //                   history contains dates that WERE pruned before 0022.
  const noActionCutoff = addDays(opts.today, -MIN_AGE_DAYS);
  const floor = await retentionFloor(db);
  // Both conditions must hold for aged-out, so it is the EARLIER of the two.
  // Null floor (empty source_rows — fresh database, restore in progress, a
  // prune that over-ran) means we cannot claim anything expired, so we never
  // do: declining is right for THIS branch and irrelevant to the other one.
  const agedOutCutoff = floor === null ? null : floor < noActionCutoff ? floor : noActionCutoff;

  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("variances")
      .select("id, city, business_date, direction, variance_name, bucket, job_type, note")
      .eq("status", "open")
      // The wider of the two cutoffs; agedOutCutoff is never later than this.
      .lt("business_date", noActionCutoff)
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
  let leftOpen = 0;
  for (const r of rows) {
    // The same label the digest and both dashboards read, with the same context
    // fields — so a row the owner sees as "For information" on screen is settled
    // here for exactly that reason, and never for a different one.
    const label = labelFor(r.variance_name, {
      direction: (r.direction as "IN" | "OUT" | "CROSS" | null) ?? null,
      jobType: r.job_type,
      bucket: (r.bucket as "REAL" | "INFO" | null) ?? null,
      note: r.note,
    });
    if (label.tier === 3) {
      noActionIds.push(r.id);
    } else if (agedOutCutoff !== null && r.business_date < agedOutCutoff) {
      agedOutIds.push(r.id);
    } else {
      // Actionable, and its evidence is still on file — so it stays open. This
      // is the branch that did not exist before 0022, and it is the whole point
      // of keeping the raw feed: a real finding is never closed for the
      // convenience of the queue.
      leftOpen++;
      continue;
    }
    byCity[r.city] = (byCity[r.city] ?? 0) + 1;
  }

  const result: SettleResult = {
    cutoff: agedOutCutoff,
    noActionCutoff,
    agedOut: agedOutIds.length,
    noAction: noActionIds.length,
    leftOpen,
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
