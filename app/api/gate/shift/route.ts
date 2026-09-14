// GET /api/gate/shift?guardId=&clientShiftId= — is this shift still open?
//
// WHY. A phone left open all day never asked. Delhi, 12–13 Sep 2026: Mahilal
// and Deepak checked in at 18:41, nobody signed out, and the nightly sweep
// closed both shifts 16 hours later — but their phones still held the shift,
// so that evening they recorded trips without being checked in, and attendance
// shows them absent on a day they worked. The phone now asks this on a timer
// and before starting a trip, and sends the guard to check in again.
//
// Answers about ONE shift, by the phone's own id, and only the guard's own.
// "unknown" is not "closed": a shift checked in offline is not on the server
// yet, and the phone must not throw a guard out for that.

import { NextResponse, type NextRequest } from "next/server";
import { jsonRoute } from "@/lib/api/json-route";
import { createAdminClient } from "@/lib/supabase/admin";
import { identifyDevice, withGuard } from "@/lib/gate/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = jsonRoute("gate/shift", async (req: NextRequest) => {
  const admin = createAdminClient();
  const device = await identifyDevice(admin, req.headers.get("authorization"));
  if (!device) return NextResponse.json({ error: "unknown or revoked device" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const who = await withGuard(admin, device, sp.get("guardId"));
  if (!who) return NextResponse.json({ error: "no active guard" }, { status: 403 });

  const clientShiftId = sp.get("clientShiftId");
  if (!clientShiftId) return NextResponse.json({ error: "clientShiftId required" }, { status: 400 });

  const { data, error } = await admin.from("guard_shifts")
    .select("status,auto_closed,checked_out_at")
    .eq("client_shift_id", clientShiftId).eq("guard_id", who.guardId).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (!data) return NextResponse.json({ state: "unknown" }, { headers: { "Cache-Control": "no-store" } });
  const state = data.status === "open" ? "open"
    : data.auto_closed || data.status === "auto_closed" ? "auto_closed" : "closed";
  return NextResponse.json({ state }, { headers: { "Cache-Control": "no-store" } });
});
