// Attendance for one day: every guard on the city's roster, with first sign-in
// and last sign-out and the face check behind each. See lib/gate/attendance.ts
// for which day a shift belongs to.

import { NextResponse, type NextRequest } from "next/server";
import { jsonRoute } from "@/lib/api/json-route";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { attendanceFor, type FaceRow, type ShiftRow } from "@/lib/gate/attendance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const todayIst = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

export const GET = jsonRoute("gate/attendance", async (req: NextRequest) => {
  const me = await getCurrentAppUser();
  if (!me || (me.role !== "admin" && me.role !== "manager")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const sp = req.nextUrl.searchParams;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(sp.get("date") ?? "") ? sp.get("date")! : todayIst();
  const city = me.role === "manager" ? me.city : sp.get("city");
  const admin = createAdminClient();

  // A shift that started on `date` IST began between these instants. A day
  // either side keeps the query cheap without losing a night shift.
  const from = new Date(Date.parse(`${date}T00:00:00+05:30`)).toISOString();
  const to = new Date(Date.parse(`${date}T00:00:00+05:30`) + 86_400_000).toISOString();

  let roster = admin.from("app_users").select("id,name,city,status").eq("role", "guard");
  let shiftsQ = admin.from("guard_shifts")
    .select("id,guard_id,city,checked_in_at,checked_out_at,status,auto_closed_reason,auto_closed,in_geo_ok,out_geo_ok")
    .gte("checked_in_at", from).lt("checked_in_at", to);
  if (city) { roster = roster.eq("city", city); shiftsQ = shiftsQ.eq("city", city); }

  const [ro, sh] = await Promise.all([roster, shiftsQ]);
  if (ro.error) return NextResponse.json({ error: ro.error.message }, { status: 500 });
  if (sh.error) return NextResponse.json({ error: sh.error.message }, { status: 500 });

  const shifts = (sh.data ?? []) as Record<string, unknown>[];
  const shiftIds = shifts.map((s) => s.id as string);
  let faces: Record<string, unknown>[] = [];
  if (shiftIds.length) {
    const f = await admin.from("guard_face_checks")
      .select("id,shift_id,trigger,verdict,match_score,captured_at,selfie_path,review_state")
      .in("shift_id", shiftIds);
    if (f.error) return NextResponse.json({ error: f.error.message }, { status: 500 });
    faces = (f.data ?? []) as Record<string, unknown>[];
  }

  const days = attendanceFor(date,
    shifts.map((s): ShiftRow => ({
      id: s.id as string, guardId: s.guard_id as string, checkedInAt: s.checked_in_at as string,
      checkedOutAt: (s.checked_out_at as string) ?? null, status: s.status as string,
      autoClosedReason: (s.auto_closed_reason as string) ?? null,
      inGeoOk: (s.in_geo_ok as boolean) ?? null, outGeoOk: (s.out_geo_ok as boolean) ?? null,
      autoClosed: !!s.auto_closed,
    })),
    faces.map((f): FaceRow => ({
      id: f.id as string, shiftId: (f.shift_id as string) ?? null, trigger: f.trigger as string,
      verdict: f.verdict as string, matchScore: (f.match_score as number) ?? null,
      capturedAt: f.captured_at as string, hasSelfie: !!f.selfie_path, reviewState: (f.review_state as string) ?? null,
    })));

  const guards = ((ro.data ?? []) as Record<string, unknown>[]);
  // Anyone who worked that day is listed even if since removed from the roster.
  const names = new Map(guards.map((g) => [g.id as string, { name: g.name as string, city: g.city as string, active: g.status === "active" }]));
  const ids = new Set([...guards.filter((g) => g.status === "active").map((g) => g.id as string), ...days.keys()]);

  const rows = [...ids].map((id) => ({
    ...(days.get(id) ?? { guardId: id, shifts: 0, firstIn: null, lastOut: null, onDuty: false, minutes: null }),
    name: names.get(id)?.name ?? "(removed guard)",
    city: names.get(id)?.city ?? null,
  })).sort((a, b) => Number(!!b.firstIn) - Number(!!a.firstIn) || a.name.localeCompare(b.name));

  return NextResponse.json({
    date,
    totals: {
      guards: rows.length,
      present: rows.filter((r) => r.firstIn).length,
      onDuty: rows.filter((r) => r.onDuty).length,
      // A sign-out with no face — made before the end-of-shift photo existed,
      // or closed by the nightly sweep — is shown as such, not as a pass.
      signedOutWithoutFace: rows.filter((r) => r.lastOut && !r.lastOut.auto && !r.lastOut.face).length,
      notSignedOut: rows.filter((r) => r.lastOut?.auto).length,
    },
    rows,
  });
});
