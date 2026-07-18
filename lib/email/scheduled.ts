// Deferred / scheduled digest sends. An admin queues a digest to go out N days
// after a reconcile ("send once the variances are resolved"); the existing daily
// email-digest cron drains this queue on each run — no extra Vercel cron (Hobby
// 2-cron cap). The digest is ALWAYS re-derived from the DB at send time, so a
// deferred email reflects the latest closure state, not the state when queued.

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildDigestFromDb, sendReconciliationDigest } from "./index";
import { saveEmailLog } from "../db/persist";
import type { ScheduledEmailDB } from "../db/schema";

// A scheduled send that keeps failing its "resolved" gate is abandoned after
// this many daily attempts (≈ a week of retries) so it never loops forever.
const MAX_ATTEMPTS = 7;

export interface DrainResult {
  id: string;
  businessDate: string;
  status: "sent" | "failed" | "waiting" | "skipped";
  open?: number;
  error?: string;
}

// Count of REAL variances still open (not closed) for a business date — the
// "is this day resolved yet?" gate. pending_approval counts as still-open.
async function openRealCount(db: SupabaseClient, businessDate: string): Promise<number> {
  const { count } = await db
    .from("variances")
    .select("id", { count: "exact", head: true })
    .eq("business_date", businessDate)
    .eq("bucket", "REAL")
    .neq("status", "closed");
  return count ?? 0;
}

export async function drainScheduledEmails(db: SupabaseClient, nowIso: string): Promise<DrainResult[]> {
  const { data: due, error } = await db
    .from("scheduled_emails")
    .select("*")
    .eq("status", "pending")
    .lte("send_at", nowIso)
    .order("send_at", { ascending: true })
    .limit(50);
  if (error) throw new Error(`drainScheduledEmails query failed: ${error.message}`);

  const results: DrainResult[] = [];

  for (const row of (due ?? []) as ScheduledEmailDB[]) {
    const attempts = (row.attempts ?? 0) + 1;

    // Atomically CLAIM the row (pending → sending) so a concurrent cron run can't
    // send it twice — the .eq("status","pending") makes the update a no-op if
    // another worker already grabbed it.
    const { data: claimed } = await db
      .from("scheduled_emails")
      .update({ status: "sending", attempts })
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (!claimed) continue; // lost the race

    try {
      // "Send once resolved" gate — hold (or eventually give up) while REAL
      // variances for the date are still open.
      if (row.require_resolved) {
        const open = await openRealCount(db, row.business_date);
        if (open > 0) {
          if (attempts >= MAX_ATTEMPTS) {
            await db
              .from("scheduled_emails")
              .update({ status: "skipped", last_error: `abandoned: ${open} REAL variances still open after ${attempts} attempts` })
              .eq("id", row.id);
            results.push({ id: row.id, businessDate: row.business_date, status: "skipped", open });
          } else {
            await db
              .from("scheduled_emails")
              .update({ status: "pending", last_error: `waiting: ${open} REAL variances still open` })
              .eq("id", row.id);
            results.push({ id: row.id, businessDate: row.business_date, status: "waiting", open });
          }
          continue;
        }
      }

      const digest = await buildDigestFromDb(db, row.business_date);
      const result = await sendReconciliationDigest(digest, {
        to: row.recipients?.length ? row.recipients : undefined,
        cc: row.cc ?? [],
        bcc: row.bcc ?? [],
        notes: row.notes ?? undefined,
      });

      const logId = await saveEmailLog(db, {
        kind: "scheduled",
        businessDate: row.business_date,
        status: result.sent ? "sent" : result.error ? "failed" : "skipped",
        recipients: result.recipients ?? [],
        cc: result.cc ?? [],
        bcc: result.bcc ?? [],
        notes: row.notes ?? null,
        sentBy: row.scheduled_by ?? null,
        messageId: result.messageId ?? null,
        error: result.error ?? result.skipped ?? null,
      }).catch(() => null);

      await db
        .from("scheduled_emails")
        .update({
          status: result.sent ? "sent" : "failed",
          last_error: result.error ?? result.skipped ?? null,
          email_log_id: logId,
        })
        .eq("id", row.id);
      results.push({
        id: row.id,
        businessDate: row.business_date,
        status: result.sent ? "sent" : "failed",
        error: result.error ?? result.skipped ?? undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.from("scheduled_emails").update({ status: "failed", last_error: message }).eq("id", row.id);
      results.push({ id: row.id, businessDate: row.business_date, status: "failed", error: message });
    }
  }

  return results;
}
