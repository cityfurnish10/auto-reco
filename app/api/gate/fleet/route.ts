// GET /api/gate/fleet — the vehicles and delivery agents scheduled at this
// gate, read LIVE from the Delivery Tracker.
//
// Live rather than from the overnight job, because plans change until the last
// minute: a truck swapped at 18:00 is routine, and a list built at 07:00 would
// be wrong exactly when the guard needs it. The phone calls this when the app
// opens and again when a trip is about to start.
//
// The city is taken from the DEVICE, never from the request. A phone cannot
// ask for another gate's fleet, which is the mistake a `?city=` parameter
// would invite on day one.
//
// Failure here is not an error the guard sees. An empty list means the trip
// form shows a plain text box, which is what it did before this existed.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { identifyDevice } from "@/lib/gate/auth";
import { EMPTY_FLEET, fleetForCity } from "@/lib/gate/fleet";
import type { City } from "@/lib/sample-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function GET(req: NextRequest) {
  const admin = createAdminClient();
  const device = await identifyDevice(admin, req.headers.get("authorization"));
  if (!device) {
    return NextResponse.json({ error: "unknown or revoked device" }, { status: 401 });
  }

  const fleet = await fleetForCity(device.city as City).catch(() => EMPTY_FLEET);
  return NextResponse.json(fleet, {
    // Never cached. The whole point is that it is current; a CDN holding this
    // for five minutes would reintroduce the staleness it was built to remove.
    headers: { "Cache-Control": "no-store" },
  });
}
