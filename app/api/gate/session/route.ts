// Gate sign-in.
//
//   GET  — who may work at this gate today (the name list the guard taps)
//   POST — verify that guard's own PIN
//
// The device token says WHICH GATE. This says WHO. Splitting the two is what
// lets three guards share a phone and still produce individual attendance and
// task logs — the reason this exists at all.
//
// The PIN is a local unlock, and this route is the online confirmation of it.
// It is not the identity control: impersonating a colleague is caught by the
// check-in selfie failing to match that guard's own reference photo.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { guardsForDevice, identifyDevice, verifyGuardPin } from "@/lib/gate/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const admin = createAdminClient();
  const device = await identifyDevice(admin, req.headers.get("authorization"));
  if (!device) return NextResponse.json({ error: "unknown or revoked device" }, { status: 401 });

  // Descriptors, not photographs. The phone matches against 128 numbers, so no
  // guard's face is ever cached on a colleague's personal device — which
  // matters now that a device serves everyone working that gate.
  const guards = await guardsForDevice(admin, device);
  return NextResponse.json({
    site: { city: device.city, code: device.siteCode },
    guards: guards.map((g) => ({
      guardId: g.guardId,
      name: g.name,
      employeeCode: g.employeeCode,
      descriptor: g.descriptor,
      enrolled: !!g.descriptor,
    })),
  });
}

export async function POST(req: NextRequest) {
  const admin = createAdminClient();
  const device = await identifyDevice(admin, req.headers.get("authorization"));
  if (!device) return NextResponse.json({ error: "unknown or revoked device" }, { status: 401 });

  let body: { guardId?: string; pin?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 400 }); }

  if (!body.guardId || !body.pin) return NextResponse.json({ ok: false }, { status: 400 });

  // Scoped to this device's own city, so a phone at one gate cannot sign in a
  // guard from another — the mistake a shared codebase makes by accident.
  const guards = await guardsForDevice(admin, device);
  if (!guards.some((g) => g.guardId === body.guardId)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  if (!(await verifyGuardPin(admin, body.guardId, body.pin))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const g = guards.find((x) => x.guardId === body.guardId)!;
  return NextResponse.json({ ok: true, guard: { id: g.guardId, name: g.name } });
}
