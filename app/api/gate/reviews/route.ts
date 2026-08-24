// The face-check review queue.
//
//   GET   — checks needing a human glance
//   PATCH — accept or reject one
//
// Scoped like every other screen: a city manager sees their own city, an admin
// sees all. That is deliberate rather than incidental — the point of a review
// is that someone who KNOWS the guard by sight looks at it, and that person is
// the city manager, not head office.
//
// Nothing here can lock a guard out; the shift already happened. A rejection is
// a record that the person in the photo was not who signed in, which is an HR
// conversation, not an access control.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { ATTENDANCE_BUCKET, signPhotoRead } from "@/lib/gate/evidence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const me = await getCurrentAppUser();
  if (!me || (me.role !== "admin" && me.role !== "manager")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const admin = createAdminClient();
  const state = req.nextUrl.searchParams.get("state") ?? "pending";

  let q = admin
    .from("guard_face_checks")
    .select("id,guard_id,city,trigger,captured_at,selfie_path,match_score,verdict,review_state,geo_ok,app_users!guard_id!inner(name)")
    .order("captured_at", { ascending: false })
    .limit(100);
  if (state !== "all") q = q.eq("review_state", state);
  if (me.role === "manager") q = q.eq("city", me.city ?? "");

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Signed links, half an hour. The bucket is private and these are faces.
  const checks = await Promise.all(
    ((data ?? []) as Record<string, unknown>[]).map(async (r) => ({
      id: r.id,
      guardName: (r.app_users as { name?: string })?.name ?? "",
      city: r.city,
      trigger: r.trigger,
      capturedAt: r.captured_at,
      matchScore: r.match_score,
      verdict: r.verdict,
      reviewState: r.review_state,
      geoOk: r.geo_ok,
      selfieUrl: r.selfie_path
        ? await signPhotoRead(admin, ATTENDANCE_BUCKET, r.selfie_path as string, 1800)
        : null,
    }))
  );
  return NextResponse.json({ checks });
}

export async function PATCH(req: NextRequest) {
  const me = await getCurrentAppUser();
  if (!me || (me.role !== "admin" && me.role !== "manager")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: { id?: string; decision?: "accepted" | "rejected"; note?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 400 }); }
  if (!body.id || (body.decision !== "accepted" && body.decision !== "rejected")) {
    return NextResponse.json({ error: "id and decision are required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("guard_face_checks").select("id,city").eq("id", body.id).maybeSingle();
  if (!row) return NextResponse.json({ error: "no such check" }, { status: 404 });
  if (me.role === "manager" && row.city !== me.city) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { error } = await admin.from("guard_face_checks").update({
    review_state: body.decision,
    reviewed_by: me.id,
    reviewed_at: new Date().toISOString(),
    review_note: body.note?.trim() || null,
  }).eq("id", body.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
