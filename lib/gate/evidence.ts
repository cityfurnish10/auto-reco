// Evidence storage: item photos and attendance selfies.
//
// Two buckets because they expire on different clocks -- 90 days for item
// photos, 45 for attendance -- and because a manager reviewing selfies and an
// auditor pulling a dispute photo are different permissions and should stay
// separable.
//
// Both are PRIVATE. Nothing here is ever a public URL: reads go out as
// short-lived signed links, and writes come back as one-time upload links so
// the bytes never pass through a serverless function.

import type { SupabaseClient } from "@supabase/supabase-js";

export const EVIDENCE_BUCKET = "gate-evidence";
export const ATTENDANCE_BUCKET = "gate-attendance";

/** Idempotent — "already exists" is the normal answer after the first call. */
/**
 * Make sure both buckets exist. Returns what went wrong, if anything.
 *
 * THE OLD VERSION SWALLOWED TWO DIFFERENT THINGS AND REPORTED NEITHER.
 * `createBucket` resolves with `{ data, error }` rather than throwing, so the
 * `.catch(() => {})` on it caught nothing at all — and the error inside the
 * result was discarded by not being read. "Already exists" is the expected
 * case and is fine to ignore; anything else means uploads are about to fail
 * silently, which is exactly what happened to a guard's reference photo.
 */
export async function ensureBuckets(admin: SupabaseClient): Promise<string[]> {
  const problems: string[] = [];
  for (const b of [EVIDENCE_BUCKET, ATTENDANCE_BUCKET]) {
    try {
      const { error } = await admin.storage.createBucket(b, { public: false });
      // The bucket already being there is the normal path, not a problem.
      if (error && !/exist/i.test(error.message)) problems.push(`${b}: ${error.message}`);
    } catch (e) {
      problems.push(`${b}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return problems;
}

export interface PhotoSlot { clientId: string; path: string; token?: string; error?: string }

/**
 * One-time upload links for the photos a batch still owes us.
 *
 * Best-effort per photo: a storage hiccup must not fail the sync that already
 * stored the movements. A row whose link failed simply has no link, the phone
 * keeps the image queued, and the next sync asks again.
 */
export async function signPhotoUploads(
  admin: SupabaseClient,
  wanted: { clientId: string; path: string }[],
  bucket: string = EVIDENCE_BUCKET
): Promise<PhotoSlot[]> {
  if (wanted.length === 0) return [];
  await ensureBuckets(admin);
  const out: PhotoSlot[] = [];
  for (const w of wanted) {
    const { data, error } = await admin.storage
      .from(bucket)
      .createSignedUploadUrl(w.path);
    out.push(
      error || !data
        ? { ...w, error: error?.message ?? "could not create upload link" }
        : { ...w, token: data.token }
    );
  }
  return out;
}

/** A short-lived link to look at one stored image. */
export async function signPhotoRead(
  admin: SupabaseClient, bucket: string, path: string, seconds = 1800
): Promise<string | null> {
  const { data } = await admin.storage.from(bucket).createSignedUrl(path, seconds);
  return data?.signedUrl ?? null;
}
