// GET /api/gate/bootstrap — everything the phone needs to work offline.
//
// Called at shift start and whenever the app regains a connection. It returns
// the day's expected items, the guard's current state, and the config the
// device then ENFORCES on its own for hours — the geofence and whether the
// expected-list warning is live. That is why config lives in one module: if the
// phone's copy and the server's ever diverge, the phone wins for a whole shift.
//
// Deliberately small. This is downloaded over a warehouse connection at shift
// change, sometimes by three phones at once.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { identifyDevice, withGuard } from "@/lib/gate/auth";
import { EXPECTED_CHECK_LIVE, COMPLETENESS_SHOWN, OUTWARD_PHOTO_SAMPLE_RATE, loadSite } from "@/lib/gate/config";
import { currentBusinessDate } from "@/lib/reconcile/cron-dates";
import { ensureExpectedFresh } from "@/lib/gate/expected";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const admin = createAdminClient();
  const device = await identifyDevice(admin, req.headers.get("authorization"));
  if (!device) return NextResponse.json({ error: "unknown or revoked device" }, { status: 401 });

  // The signed-in guard, so the resume state is THEIRS. Without it the app
  // would show one guard the open trip of whoever used the phone last.
  const who = await withGuard(admin, device, req.nextUrl.searchParams.get("guardId"));

  // The business day currently OPEN — what the guard is working inside right
  // now — not the day the reconcile is closing, which is two days behind.
  const businessDate = currentBusinessDate();

  // Kick the expected list into shape, but do NOT wait for it, and do NOT send
  // it. Odoo goes through Metabase and takes seconds; the app opening must not.
  //
  // THE PHONE NEVER RECEIVES THE PLAN. It used to, so it could label a scan
  // itself — which put the day's expectations on the handset and left a rule,
  // rather than an absence, as the only thing stopping a guard reading them.
  // Scans are labelled on the server now (see enrichScans in sync.ts), and the
  // refresh here exists so that lookup has something current to read.

  void ensureExpectedFresh(admin, businessDate).catch(() => {});

  const [openTrip, openShift] = await Promise.all([
    // BOUNDED BY THE BUSINESS DAY, and ordered-then-limited rather than
    // .maybeSingle() on its own. Both details were bugs:
    //
    //   unbounded   a trip left open yesterday was offered this morning as
    //               "resume trip", on yesterday's truck. One was.
    //   maybeSingle two matching rows make it an ERROR, and the error was read
    //               as "no open shift" below — which sent the guard to check
    //               in, creating a third. One guard reached seventeen.
    //
    // 0032 makes a second open shift impossible, but a read that cannot
    // survive one is a read that will break again on the next thing nobody
    // thought to constrain.
    who
      ? admin.from("gate_trips")
          .select("id,client_trip_id,direction,vehicle_no,opened_at")
          .eq("guard_id", who.guardId).eq("status", "open")
          .eq("business_date", businessDate)
          .order("opened_at", { ascending: false }).limit(1).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    who
      ? admin.from("guard_shifts")
          .select("id,client_shift_id,checked_in_at")
          .eq("guard_id", who.guardId).eq("status", "open")
          .eq("business_date", businessDate)
          .order("checked_in_at", { ascending: false }).limit(1).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  const site = await loadSite(admin, device.city);

  return NextResponse.json({
    // Null when no guard has signed in yet — the app then shows the name list.
    guard: who ? { id: who.guardId, name: who.guardName } : null,
    site_city: device.city,
    businessDate,
    site: site
      ? { code: site.siteCode, label: site.label, lat: site.lat, lng: site.lng, radiusM: site.radiusM }
      : null,
    config: {
      // The phone applies this itself while offline; the server re-decides on
      // sync, so a tampered client cannot opt itself out of being sampled.
      outwardPhotoSampleRate: OUTWARD_PHOTO_SAMPLE_RATE,
      // False through the pilot: the check still runs and is recorded, it is
      // just not shown, so the false-alarm rate can be measured before any
      // guard is taught to dismiss a warning.
      expectedCheckLive: EXPECTED_CHECK_LIVE,
      completenessShown: COMPLETENESS_SHOWN,
    },
    // Resuming state. A phone that died mid-trip comes back to the same truck
    // rather than silently starting a second one.
    // If either of these errors, SAY SO rather than reporting null. Null means
    // "you have no open shift", and the app acts on that by starting a new one
    // — which is precisely how seventeen of them accumulated while the real
    // cause went unlogged.
    openTrip: openTrip.data ?? null,
    openShift: openShift.data ?? null,
    resumeError: openTrip.error?.message ?? openShift.error?.message ?? null,
    // Deliberately absent: the expected list. The gate is only worth having as
    // an INDEPENDENT witness, and a guard who can see what is expected scans
    // against the expectation rather than recording what is in front of them.
    // Kept as a count of zero rather than removed outright so an older app
    // build reads "nothing planned" instead of crashing on a missing field.
    expected: [],
    expectedCount: 0,
  });
}
