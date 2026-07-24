// 30-day archive of SENT digest emails — one JSON document per email_logs row
// in a private Supabase Storage bucket ("email-archive"), holding the exact
// subject + HTML that went to the wire. Storage (not a table column) so no SQL
// migration is needed; service-role only, same pattern as recipient-store.ts.
//
// Write path: each send site archives best-effort right after saveEmailLog
// (a storage outage must never fail a send). Read path: the email page's
// archive viewer (/api/email/archive/[id]). Retention: the daily email cron
// prunes email_logs rows older than 30 days and removes their documents here.

import type { SupabaseClient } from "@supabase/supabase-js";

const BUCKET = "email-archive";
const keyFor = (logId: string) => `${logId}.json`;

export interface ArchivedEmail {
  subject: string;
  html: string;
}

export async function saveEmailArchive(
  admin: SupabaseClient,
  logId: string,
  doc: ArchivedEmail
): Promise<void> {
  // Idempotent bucket create — "already exists" is fine.
  await admin.storage.createBucket(BUCKET, { public: false }).catch(() => {});
  const { error } = await admin.storage
    .from(BUCKET)
    .upload(keyFor(logId), JSON.stringify(doc), {
      contentType: "application/json",
      upsert: true,
    });
  if (error) throw new Error(`saveEmailArchive: ${error.message}`);
}

export async function loadEmailArchive(
  admin: SupabaseClient,
  logId: string
): Promise<ArchivedEmail | null> {
  const { data, error } = await admin.storage.from(BUCKET).download(keyFor(logId));
  if (error || !data) return null; // never archived (pre-feature log) — caller falls back
  try {
    const doc = JSON.parse(await data.text()) as Partial<ArchivedEmail>;
    if (typeof doc.subject !== "string" || typeof doc.html !== "string") return null;
    return { subject: doc.subject, html: doc.html };
  } catch {
    return null;
  }
}

// Remove the archived documents for a set of pruned email_logs ids.
// Best-effort by contract — a failed remove only leaves an orphaned file.
export async function pruneEmailArchive(
  admin: SupabaseClient,
  logIds: string[]
): Promise<void> {
  for (let i = 0; i < logIds.length; i += 100) {
    await admin.storage
      .from(BUCKET)
      .remove(logIds.slice(i, i + 100).map(keyFor))
      .catch(() => {});
  }
}
