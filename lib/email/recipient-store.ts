// Server-side persistence for the digest recipient list — a JSON document in a
// private Supabase Storage bucket ("app-config"). Storage (not a table) so no
// SQL migration is needed; access is service-role only via the admin API route
// and the crons, never directly from the browser.
//
// The stored document IS the compose panel's RecipientState (slots/extra/
// removed), so the UI hydrates it verbatim and the nightly digest derives its
// To/Cc/Bcc from the same source the admin sees on screen.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  listsOf,
  sanitizeRecipientState,
  type RecipientState,
} from "./recipient-list";

const BUCKET = "app-config";
const FILE = "digest-recipients.json";

export async function loadRecipientState(
  admin: SupabaseClient
): Promise<RecipientState | null> {
  const { data, error } = await admin.storage.from(BUCKET).download(FILE);
  if (error || !data) return null; // bucket/file not created yet — no config
  try {
    return sanitizeRecipientState(JSON.parse(await data.text()));
  } catch {
    return null; // unreadable JSON — treat as unset rather than crash sends
  }
}

export async function saveRecipientState(
  admin: SupabaseClient,
  state: RecipientState
): Promise<void> {
  // Idempotent bucket create — "already exists" is fine.
  await admin.storage.createBucket(BUCKET, { public: false }).catch(() => {});
  const clean = sanitizeRecipientState(state);
  const { error } = await admin.storage
    .from(BUCKET)
    .upload(FILE, JSON.stringify(clean, null, 1), {
      contentType: "application/json",
      upsert: true,
    });
  if (error) throw new Error(`saveRecipientState: ${error.message}`);
}

// The To/Cc/Bcc the scheduled digest should use — null when no admin has
// curated a list yet (callers fall back to the DIGEST_RECIPIENTS env default).
export async function storedDigestLists(
  admin: SupabaseClient
): Promise<{ to: string[]; cc: string[]; bcc: string[] } | null> {
  const state = await loadRecipientState(admin);
  if (!state) return null;
  const lists = listsOf(state);
  return lists.to.length ? lists : null; // an empty To must never silence the digest
}
