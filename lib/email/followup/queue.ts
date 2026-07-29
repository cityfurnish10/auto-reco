// Queueing a follow-up when the daily digest goes out.
//
// It rides the existing scheduled_emails table drained by the digest cron —
// Vercel Hobby caps at two crons and both are used, so a third schedule does
// not exist. lib/email/scheduled.ts set that precedent.

import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays } from "../../engine/dates";
import type { TotalsSnapshot } from "./snapshot";

/**
 * Business date + 3.
 *
 * D's digest goes out on D+1, and the follow-up two days after that. The
 * reconcile cron's re-check pass re-runs D on the same afternoon — see
 * recheckTargetDate(), which must stay in step with this number.
 */
export const FOLLOW_UP_DELAY_DAYS = 3;

/**
 * 11:00Z — fifteen minutes BEFORE the 11:15Z digest cron.
 *
 * `send_at <= now` with any negative cron jitter would otherwise miss the drain
 * and slip the follow-up a whole day.
 */
const SEND_AT_UTC = "T11:00:00.000Z";

export function followUpSendAt(businessDate: string): string {
  return `${addDays(businessDate, FOLLOW_UP_DELAY_DAYS)}${SEND_AT_UTC}`;
}

export interface EnqueueDecision {
  enqueue: boolean;
  reason?: string;
}

/**
 * Whether a digest send earns a follow-up.
 *
 * Pure, so every branch is a unit test.
 */
export function shouldEnqueueFollowUp(input: {
  sent: boolean;
  runIncomplete?: boolean;
  snapshot: TotalsSnapshot | null;
}): EnqueueDecision {
  if (!input.sent) return { enqueue: false, reason: "digest was not sent" };
  if (input.runIncomplete) return { enqueue: false, reason: "no completed run for the date" };
  if (!input.snapshot) return { enqueue: false, reason: "no figures captured" };
  // "Of the 0 items flagged, 0 remain" is noise. The day's digest already said
  // everything was accounted for.
  if (input.snapshot.overall.flagged === 0) return { enqueue: false, reason: "nothing was flagged" };
  return { enqueue: true };
}

/**
 * Insert the queue row. Best-effort by design — a failure here must never
 * affect the digest that has already been sent.
 */
export async function enqueueFollowUp(
  db: SupabaseClient,
  args: {
    businessDate: string;
    sourceEmailLogId: string | null;
    recipients: string[];
    cc: string[];
    bcc: string[];
  }
): Promise<boolean> {
  const { error } = await db.from("scheduled_emails").insert({
    kind: "follow_up",
    business_date: args.businessDate,
    send_at: followUpSendAt(args.businessDate),
    status: "pending",
    // FALSE, unlike a deferred digest. The point is to report what remains, not
    // to wait until nothing does.
    require_resolved: false,
    // Copied from the actual send, not left empty: the drain's fallback is the
    // DIGEST_RECIPIENTS env var, not the curated list, so an empty row would
    // mail a different set of people than the digest it follows up on.
    recipients: args.recipients,
    cc: args.cc,
    bcc: args.bcc,
    source_email_log_id: args.sourceEmailLogId,
  });
  if (error) {
    // 23505 = the one-live-follow-up-per-date unique index. A manual re-send of
    // the day's digest hits this, and doing nothing is exactly right.
    if (error.code === "23505") return false;
    console.warn("enqueueFollowUp failed:", error.code ?? "", error.message);
    return false;
  }
  return true;
}
