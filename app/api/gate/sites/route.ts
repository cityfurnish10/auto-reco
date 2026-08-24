// The warehouse gates.
//
//   GET   — the five sites, with whether each has been pinned
//   PATCH — pin one, from the coordinates of the device asking
//
// Coordinates are captured ON SITE rather than geocoded. Searching the postal
// address returns the centre of the village — over a kilometre from the
// building at Dera Mandi — and a geofence built on that looks correct while
// rejecting every honest scan.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const me = await getCurrentAppUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("gate_sites")
    .select("city,site_code,label,address,serves,plus_code,lat,lng,radius_m,located_at,accuracy_m")
    .order("label");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // A manager sees only their own gate; an admin sees all five.
  const rows = (data ?? []).filter((r) => me.role === "admin" || r.city === me.city);
  return NextResponse.json({
    sites: rows.map((r) => ({
      city: r.city, siteCode: r.site_code, label: r.label,
      address: r.address, serves: r.serves, plusCode: r.plus_code,
      lat: r.lat, lng: r.lng, radiusM: r.radius_m,
      locatedAt: r.located_at, accuracyM: r.accuracy_m,
      pinned: r.lat != null && r.lng != null,
    })),
  });
}

export async function PATCH(req: NextRequest) {
  const me = await getCurrentAppUser();
  if (!me || (me.role !== "admin" && me.role !== "manager")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { city?: string; lat?: number; lng?: number; accuracyM?: number; radiusM?: number };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 400 }); }

  if (!body.city) return NextResponse.json({ error: "city is required" }, { status: 400 });
  if (me.role === "manager" && body.city !== me.city) {
    return NextResponse.json({ error: "you can only set your own gate" }, { status: 403 });
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (body.lat != null && body.lng != null) {
    // Refuse a fix that is obviously not a location. A browser that returns
    // 0,0 or a wildly out-of-range value should not silently become the gate.
    if (Math.abs(body.lat) > 90 || Math.abs(body.lng) > 180 ||
        (body.lat === 0 && body.lng === 0)) {
      return NextResponse.json({ error: "that does not look like a real position" }, { status: 400 });
    }
    // A phone that only knows where it is to within a kilometre has not told
    // us where the gate is. Better to refuse than to pin the wrong spot and
    // have every scan quietly fail the check afterwards.
    if (body.accuracyM != null && body.accuracyM > 200) {
      return NextResponse.json({
        error: `Your phone is only accurate to about ${Math.round(body.accuracyM)}m. ` +
               `Step outside and try again.`,
      }, { status: 400 });
    }
    update.lat = body.lat;
    update.lng = body.lng;
    update.accuracy_m = body.accuracyM ?? null;
    update.located_by = me.id;
    update.located_at = new Date().toISOString();
  }
  if (body.radiusM != null) {
    if (body.radiusM < 50 || body.radiusM > 5000) {
      return NextResponse.json({ error: "radius must be between 50m and 5000m" }, { status: 400 });
    }
    update.radius_m = Math.round(body.radiusM);
  }

  const admin = createAdminClient();
  const { error } = await admin.from("gate_sites").update(update).eq("city", body.city);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
