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
import { EXPECTED_CHECK_LIVE, OUTWARD_PHOTO_SAMPLE_RATE, loadSite } from "@/lib/gate/config";
import { currentBusinessDate } from "@/lib/reconcile/cron-dates";

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

  const [expected, openTrip, openShift] = await Promise.all([
    admin
      .from("gate_expected_items")
      .select("barcode,barcode_canon,direction,product,so_number,ticket_id,customer")
      .eq("city", device.city)
      .eq("business_date", businessDate),
    who
      ? admin.from("gate_trips")
          .select("id,client_trip_id,direction,vehicle_no,opened_at")
          .eq("guard_id", who.guardId).eq("status", "open").maybeSingle()
      : Promise.resolve({ data: null }),
    who
      ? admin.from("guard_shifts")
          .select("id,client_shift_id,checked_in_at")
          .eq("guard_id", who.guardId).eq("status", "open").maybeSingle()
      : Promise.resolve({ data: null }),
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
    },
    // Resuming state. A phone that died mid-trip comes back to the same truck
    // rather than silently starting a second one.
    openTrip: openTrip.data ?? null,
    openShift: openShift.data ?? null,
    expected: expected.data ?? [],
    expectedCount: expected.data?.length ?? 0,
  });
}
