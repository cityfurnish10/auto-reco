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
export async function ensureBuckets(admin: SupabaseClient): Promise<void> {
  for (const b of [EVIDENCE_BUCKET, ATTENDANCE_BUCKET]) {
    await admin.storage.createBucket(b, { public: false }).catch(() => {});
  }
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
