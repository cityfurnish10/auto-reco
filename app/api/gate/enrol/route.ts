// POST /api/gate/enrol — register a PHONE at a gate.
//
// Enrols the terminal, not a person. Guards are created separately
// (/api/gate/guards) and sign in on any active device in their city, which is
// what makes cover and mid-shift handover ordinary instead of a data problem.
//
// The device token is returned EXACTLY ONCE and stored hashed: a lost phone is
// revoked and re-enrolled, never recovered.

import { randomUUID } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { hashToken, newDeviceToken } from "@/lib/gate/auth";
import { siteFor } from "@/lib/gate/config";
import { ensureBuckets } from "@/lib/gate/evidence";
import { CITIES, type City } from "@/lib/sample-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const me = await getCurrentAppUser();
  if (!me || (me.role !== "admin" && me.role !== "manager")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { city?: string; deviceLabel?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 400 }); }

  const city = (body.city ?? me.city ?? "").trim().toUpperCase() as City;
  if (!CITIES.includes(city)) {
    return NextResponse.json({ error: "a valid city is required" }, { status: 400 });
  }
  if (me.role === "manager" && city !== me.city) {
    return NextResponse.json({ error: "you can only enrol devices in your own city" }, { status: 403 });
  }

  const admin = createAdminClient();
  const site = siteFor(city);
  const token = newDeviceToken();

  const { data, error } = await admin
    .from("gate_devices")
    .insert({
      city,
      site_code: site?.siteCode ?? city.slice(0, 3),
      device_id: randomUUID(),
      device_label: body.deviceLabel?.trim() || null,
      token_hash: hashToken(token),
      created_by: me.id,
    })
    .select("id, device_id").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await ensureBuckets(admin);

  const base = process.env.NEXT_PUBLIC_APP_URL ?? "";
  return NextResponse.json({
    ok: true,
    deviceRowId: data.id,
    deviceId: data.device_id,
    // SHOWN ONCE.
    deviceToken: token,
    // Hand this to the guard's phone; opening it once pairs the device.
    pairingUrl: `${base}/scan/pair?t=${encodeURIComponent(token)}`,
    site: site ? { code: site.siteCode, label: site.label, lat: site.lat, lng: site.lng, radiusM: site.radiusM } : null,
  });
}
