// POST /api/gate/sync — the phone's outbox arrives here.
//
// ONE endpoint for everything the device queued, rather than one per action.
// A phone that has been offline holds a trip, its scans and its attendance
// together, and splitting them across endpoints would mean several queues,
// several retry paths, and scans arriving before the trip they belong to.
//
// Authenticated by DEVICE TOKEN, not a user session: opening the app must never
// need the network, and a session expiring at 9pm at a gate is a guard locked
// out with nobody to call. Writes go through the service-role client because
// the device is not a Postgres user — every field the phone could lie about
// (city, business date, geofence, photo sampling) is decided here instead.
//
// Excluded from middleware auth via the api/gate matcher; enforces its own.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { identifyDevice, markDeviceSeen, withGuard } from "@/lib/gate/auth";
import { applyBatch, type InFaceCheck, type InScan, type InShift, type InTrip,
         type InVoid } from "@/lib/gate/sync";
import { ATTENDANCE_BUCKET, EVIDENCE_BUCKET, signPhotoUploads } from "@/lib/gate/evidence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** A phone that has been offline all shift can hold a lot; this bounds one
 *  request so a huge backlog drains over several calls instead of timing out
 *  and retrying the same oversized batch forever. */
const MAX_TRIPS = 40;
const MAX_SCANS = 400;

export async function POST(req: NextRequest) {
  const admin = createAdminClient();
  const device = await identifyDevice(admin, req.headers.get("authorization"));
  if (!device) {
    return NextResponse.json({ error: "unknown or revoked device" }, { status: 401 });
  }

  let body: { guardId?: string; trips?: InTrip[]; scans?: InScan[]; voids?: InVoid[];
              shifts?: InShift[]; faceChecks?: InFaceCheck[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Every row is attributed to the guard signed in on the phone, and the claim
  // is checked against this device's own city before anything is written.
  const who = await withGuard(admin, device, body.guardId);
  if (!who) {
    return NextResponse.json({ error: "no active guard signed in for this gate" }, { status: 403 });
  }

  const trips = (body.trips ?? []).slice(0, MAX_TRIPS);
  const scans = (body.scans ?? []).slice(0, MAX_SCANS);
  const truncated =
    (body.trips?.length ?? 0) > MAX_TRIPS || (body.scans?.length ?? 0) > MAX_SCANS;

  // Bounded like everything else, but generously: a guard correcting a badly
  // loaded truck can retract a lot of rows in one go, and a void left stuck in
  // the queue is a row still counting that the guard believes is gone.
  const voids = (body.voids ?? []).slice(0, MAX_SCANS);
  const shifts = (body.shifts ?? []).slice(0, 20);
  const faceChecks = (body.faceChecks ?? []).slice(0, 40);

  const report = await applyBatch(admin, who, { trips, scans, voids, shifts, faceChecks });
  await markDeviceSeen(admin, device.deviceRowId);

  // Upload links for the rows that need an image. Handed back rather than
  // taking the bytes inline: a serverless request caps around 4.5MB, so a
  // queue of photos would fail as a whole batch and take good movement records
  // down with it. This way the record is saved first and each photo retries on
  // its own.
  const photos = await signPhotoUploads(
    admin,
    report.scans.flatMap((s) =>
      s.status === "stored" && s.photoUploadPath
        ? [{ clientId: s.clientId, path: s.photoUploadPath }] : []
    )
  );
  // Selfies go to their own bucket — different retention (45 days vs 90) and a
  // different audience, so they stay separable.
  const selfies = await signPhotoUploads(
    admin,
    report.faceChecks.flatMap((f) =>
      f.status === "stored" && f.photoUploadPath
        ? [{ clientId: f.clientId, path: f.photoUploadPath }] : []
    ),
    ATTENDANCE_BUCKET
  );

  return NextResponse.json({
    ok: true,
    trips: report.trips,
    scans: report.scans,
    voids: report.voids,
    shifts: report.shifts,
    faceChecks: report.faceChecks,
    photos,
    selfies,
    bucket: EVIDENCE_BUCKET,
    selfieBucket: ATTENDANCE_BUCKET,
    clockWarnings: report.clockWarnings,
    // The phone keeps syncing while this is true rather than assuming it is done.
    truncated,
  });
}
