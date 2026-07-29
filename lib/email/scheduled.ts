// Deferred / scheduled digest sends. An admin queues a digest to go out N days
// after a reconcile ("send once the variances are resolved"); the existing daily
// email-digest cron drains this queue on each run — no extra Vercel cron (Hobby
// 2-cron cap). The digest is ALWAYS re-derived from the DB at send time, so a
// deferred email reflects the latest closure state, not the state when queued.

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildDigestFromDb, sendReconciliationDigest } from "./index";
import { saveEmailArchive, saveEmailPdf } from "./email-archive";
import { buildRegisterPdfs, registerAttachments } from "./register-pdf";
import { saveEmailLog } from "../db/persist";
import { sendFollowUpForRow } from "./followup/drain";
import type { ScheduledEmailDB } from "../db/schema";

// A scheduled send that keeps failing its "resolved" gate is abandoned after
// this many daily attempts (≈ a week of retries) so it never loops forever.
export const MAX_ATTEMPTS = 7;

/** Stop claiming new rows past this, so the drain cannot eat the whole budget. */
const DRAIN_BUDGET_MS = 35_000;

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

export async function drainScheduledEmails(
  db: SupabaseClient,
  nowIso: string,
  opts: { kinds?: ("digest" | "follow_up")[] } = {}
): Promise<DrainResult[]> {
  const started = Date.now();
  let q = db
    .from("scheduled_emails")
    .select("*")
    .eq("status", "pending")
    .lte("send_at", nowIso);
  if (opts.kinds?.length) q = q.in("kind", opts.kinds);
  const { data: due, error } = await q
    .order("send_at", { ascending: true })
    .limit(50);
  if (error) throw new Error(`drainScheduledEmails query failed: ${error.message}`);

  const results: DrainResult[] = [];

  for (const row of (due ?? []) as ScheduledEmailDB[]) {
    // Each row is a build + PDFs + an SMTP round trip + archive writes, roughly
    // 4s. Fifty of them is 200s against a 60s ceiling — harmless while the queue
    // was normally empty, and no longer true now that follow-ups auto-enqueue.
    // Whatever is left stays 'pending' and drains on the next run.
    if (Date.now() - started > DRAIN_BUDGET_MS) break;

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
      // A follow-up is a different email with a different gate. Everything
      // above — the claim, attempts, the retry ladder — is kind-agnostic and
      // shared; only the body differs.
      if (row.kind === "follow_up") {
        results.push(await sendFollowUpForRow(db, row, attempts));
        continue;
      }

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
      // Attach that date's ops-sheet register; never let it block the send.
      const registers = await buildRegisterPdfs(db, row.business_date).catch(() => null);
      const result = await sendReconciliationDigest(digest, {
        to: row.recipients?.length ? row.recipients : undefined,
        cc: row.cc ?? [],
        bcc: row.bcc ?? [],
        notes: row.notes ?? undefined,
        ...registerAttachments(registers),
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
    // Frozen at the wire; the follow-up's X can come from nowhere else.
    totals: result.totals ?? null,
        error: result.error ?? result.skipped ?? null,
      }).catch(() => null);
      // Snapshot the delivered email into the 30-day archive (best-effort).
      if (logId && result.sent && result.html) {
        await saveEmailArchive(db, logId, {
          subject: result.subject ?? "",
          html: result.html,
        }).catch(() => {});
        for (const r of registers?.pdfs ?? [])
      await saveEmailPdf(db, logId, r.city, r.bytes).catch(() => {});
      }

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
