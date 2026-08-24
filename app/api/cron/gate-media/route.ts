// Delete expired gate media: attendance selfies at 45 days, item photos at 90.
//
// THE RECORDS ARE KEPT; only the images go. An attendance row without its
// selfie still proves somebody checked in at a time and a place — it just can
// no longer be disputed visually. Deleting the row would erase the attendance
// history itself, which is the opposite of what retention is for.
//
// Two halves, and the order matters: remove the FILES first, then clear the
// references. A failed row-update simply means the same files are listed again
// tomorrow and the remove is a no-op; doing it the other way round would orphan
// files in storage with nothing left pointing at them.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DISABLED_BODY, cronAuthorized, scheduledJobsDisabled } from "@/lib/reconcile/cron-guard";
import { ATTENDANCE_BUCKET, EVIDENCE_BUCKET } from "@/lib/gate/evidence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ATTENDANCE_DAYS = 45;   // a full pay cycle plus a dispute window
const ITEM_DAYS = 90;         // matches the variance lifecycle

async function expire(
  db: ReturnType<typeof createAdminClient>,
  table: string, pathCol: string, timeCol: string, days: number, bucket: string
) {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = (await db
    .from(table).select(`id,${pathCol}`)
    .not(pathCol, "is", null).lt(timeCol, cutoff).limit(500)) as unknown as
    { data: Record<string, unknown>[] | null; error: { message: string } | null };
  if (error) throw new Error(`${table}: ${error.message}`);

  const rows = data ?? [];
  if (rows.length === 0) return { table, expired: 0 };

  // Storage removes in batches; 100 keeps the request comfortably small.
  const paths = rows.map((r) => r[pathCol] as string);
  for (let i = 0; i < paths.length; i += 100) {
    await db.storage.from(bucket).remove(paths.slice(i, i + 100)).catch(() => {});
  }
  const { error: uErr } = await db
    .from(table).update({ [pathCol]: null }).in("id", rows.map((r) => r.id as string));
  if (uErr) throw new Error(`${table} update: ${uErr.message}`);
  return { table, expired: rows.length };
}

async function handle(req: NextRequest) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (scheduledJobsDisabled()) return NextResponse.json(DISABLED_BODY);

  const db = createAdminClient();
  const out: unknown[] = [];
  for (const job of [
    () => expire(db, "guard_face_checks", "selfie_path", "captured_at", ATTENDANCE_DAYS, ATTENDANCE_BUCKET),
    () => expire(db, "gate_scans", "photo_path", "scanned_at", ITEM_DAYS, EVIDENCE_BUCKET),
  ]) {
    try { out.push(await job()); }
    catch (e) { out.push({ error: e instanceof Error ? e.message : String(e) }); }
  }
  return NextResponse.json({ ok: true, results: out });
}

export async function GET(req: NextRequest) { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }
