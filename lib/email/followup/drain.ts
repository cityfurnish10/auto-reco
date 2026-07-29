// Sending one queued follow-up.
//
// Shares the claim / attempts / retry machinery in lib/email/scheduled.ts and
// differs only in the gate and the body.

import type { SupabaseClient } from "@supabase/supabase-js";
import { saveEmailLog } from "../../db/persist";
import { saveEmailArchive } from "../email-archive";
import type { ScheduledEmailDB } from "../../db/schema";
import { CITIES } from "../../sample-data";
import { compareToSnapshot } from "./compare";
import { checkRerun, loadSnapshot, readCurrentRows, restDayCities } from "./build";
import { sendFollowUpEmail } from "./send";

export interface DrainOutcome {
  id: string;
  businessDate: string;
  status: "sent" | "failed" | "waiting" | "skipped";
  error?: string;
}

/**
 * Attempts before a follow-up gives up waiting for its re-check and sends
 * anyway with a stale-figures banner.
 *
 * Deliberately NOT the terminal `skipped` that a deferred digest's gate uses.
 * That gate abandons because the HUMANS did not act; this one is waiting on a
 * system that failed, and a system failure should surface as an email rather
 * than a row in a table nobody opens. The follow-up is also supplementary —
 * the day's real digest went out days ago, so a slip costs nothing.
 */
const MAX_WAIT_ATTEMPTS = 7;

export async function sendFollowUpForRow(
  db: SupabaseClient,
  row: ScheduledEmailDB,
  attempts: number
): Promise<DrainOutcome> {
  const date = row.business_date;
  const fail = async (status: "failed" | "skipped", reason: string): Promise<DrainOutcome> => {
    await db.from("scheduled_emails").update({ status, last_error: reason }).eq("id", row.id);
    return { id: row.id, businessDate: date, status, error: reason };
  };

  const snapshot = await loadSnapshot(db, row.source_email_log_id ?? null);
  if (!snapshot) {
    // Either the digest predates migration 0016, or its log row has been
    // pruned. An email that cannot say what it originally reported is worse
    // than no email — it would invite the reader to compare against the one
    // still in their inbox and find a different number.
    return fail("skipped", `no stored figures for ${date}`);
  }

  // The interlock: the whole point of a follow-up is "what remains AFTER the
  // re-check", so sending before it has run reports precisely the wrong thing.
  const { fresh, lastCompletedAt } = await checkRerun(db, date, snapshot.sentAt);
  if (!fresh && attempts < MAX_WAIT_ATTEMPTS) {
    await db
      .from("scheduled_emails")
      .update({ status: "pending", last_error: `waiting: ${date} has not been re-checked yet` })
      .eq("id", row.id);
    return { id: row.id, businessDate: date, status: "waiting" };
  }

  const current = await readCurrentRows(db, date);
  if (!current) return fail("skipped", `no completed run for ${date}`);

  const comparison = compareToSnapshot(snapshot, current);

  const result = await sendFollowUpEmail(comparison, {
    to: row.recipients ?? [],
    cc: row.cc ?? [],
    bcc: row.bcc ?? [],
    // Only when we gave up waiting — otherwise the banner would appear on every
    // healthy send and stop meaning anything.
    staleSince: fresh ? null : lastCompletedAt,
    restDayCities: restDayCities(date, [...CITIES]),
  });

  const logId = await saveEmailLog(db, {
    kind: "follow_up",
    // The date it REPORTS on, not the day it was sent, so the archive groups it
    // with the digest it follows up on.
    businessDate: date,
    status: result.sent ? "sent" : result.error ? "failed" : "skipped",
    recipients: result.recipients ?? [],
    cc: result.cc ?? [],
    bcc: result.bcc ?? [],
    messageId: result.messageId ?? null,
    error: result.error ?? result.skipped ?? null,
    // A follow-up quotes figures, it does not originate them.
    totals: null,
  }).catch(() => null);

  if (logId && result.sent && result.html) {
    await saveEmailArchive(db, logId, { subject: result.subject ?? "", html: result.html }).catch(
      () => {}
    );
  }

  await db
    .from("scheduled_emails")
    .update({
      status: result.sent ? "sent" : "failed",
      last_error: result.error ?? result.skipped ?? null,
      email_log_id: logId,
    })
    .eq("id", row.id);

  return {
    id: row.id,
    businessDate: date,
    status: result.sent ? "sent" : "failed",
    error: result.error ?? result.skipped ?? undefined,
  };
}
