// GET /api/gate/expected — the day's planned movements, as current as we can
// make them, for the gate this device belongs to.
//
// WHY IT IS A SEPARATE CALL FROM BOOTSTRAP. Bootstrap runs when the app opens
// and cannot wait on Odoo, so it serves whatever is cached and kicks off a
// refresh behind it. This is the other end: the phone calls it when a guard is
// CLOSING a trip, which is the moment the list is actually consulted and the
// one moment a couple of seconds is affordable — the guard has stopped moving,
// the truck is loaded, and the question being asked is "did I miss anything?".
//
// That timing is the whole point. Odoo pickings here are created during the
// day, not planned ahead: a list built at 07:00 held 17 rows for a day of
// ~1,451 movements, and nothing at all for tomorrow. Asking at the moment of
// use is the only way the answer means anything.
//
// The city comes from the DEVICE. A phone cannot ask what is planned at
// another gate.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { identifyDevice } from "@/lib/gate/auth";
import { ensureExpectedFresh } from "@/lib/gate/expected";
import { currentBusinessDate } from "@/lib/reconcile/cron-dates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const admin = createAdminClient();
  const device = await identifyDevice(admin, req.headers.get("authorization"));
  if (!device) {
    return NextResponse.json({ error: "unknown or revoked device" }, { status: 401 });
  }

  const businessDate = currentBusinessDate();

  // Awaited here, unlike in bootstrap. It is bounded by the Metabase timeout
  // inside fetchExpected and it never throws — the worst case is that the list
  // served below is the older one, which is still better than none.
  const fresh = await ensureExpectedFresh(admin, businessDate);

  const { data, error } = await admin
    .from("gate_expected_items")
    .select("barcode,barcode_canon,direction,product,so_number,ticket_id,customer,picking_ref,delivery_address")
    .eq("city", device.city)
    .eq("business_date", businessDate);

  if (error) {
    // The phone keeps whatever it already had. A failure to read the list must
    // never be a failure to close a trip.
    return NextResponse.json({ items: [], stale: true, error: "unavailable" }, { status: 200 });
  }

  return NextResponse.json({
    items: data ?? [],
    businessDate,
    // Told plainly, because the app has to be able to say "checked against a
    // list from an hour ago" rather than implying it checked against now.
    refreshed: fresh.refreshed,
    stale: !fresh.refreshed && fresh.reason !== "fresh",
    reason: fresh.reason ?? null,
  }, { headers: { "Cache-Control": "no-store" } });
}
