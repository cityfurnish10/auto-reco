// GET /api/gate/photo?scanId=… — a short-lived link to one item photograph.
//
// SIGNED ON DEMAND, not with the activity list. A day's activity can carry
// several hundred rows; signing every photo up front would mean several
// hundred storage round trips to render a table where a manager opens two of
// them. So the list says only WHETHER a photo exists, and this signs the one
// actually being looked at.
//
// The photos are the evidence behind a manual entry and behind every override —
// the rows where nothing else proves anything. Until now the dashboard drew a
// small camera icon next to them and offered no way to open it, which is the
// same as not having taken them.
//
// Scoped like every other gate screen: a city manager sees their own city, an
// admin sees all. Enforced against the SCAN's city rather than a parameter, so
// the id alone is not a key to another gate's evidence.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { ATTENDANCE_BUCKET, EVIDENCE_BUCKET, signPhotoRead } from "@/lib/gate/evidence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const me = await getCurrentAppUser();
  if (!me || (me.role !== "admin" && me.role !== "manager")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const admin = createAdminClient();
  const scanId = req.nextUrl.searchParams.get("scanId");
  const checkId = req.nextUrl.searchParams.get("checkId");
  if (!scanId && !checkId) {
    return NextResponse.json({ error: "scanId or checkId required" }, { status: 400 });
  }

  // An item photo and a check-in selfie live in different buckets on purpose:
  // different retention (90 days against 45) and a different audience.
  const table = scanId ? "gate_scans" : "guard_face_checks";
  const column = scanId ? "photo_path" : "selfie_path";
  const bucket = scanId ? EVIDENCE_BUCKET : ATTENDANCE_BUCKET;

  const { data, error } = await admin
    .from(table)
    .select(`${column}, city`)
    .eq("id", scanId ?? checkId)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });

  // The row's own city decides, never a parameter. Otherwise the id is a key
  // to any gate's evidence for anyone who can guess one.
  if (me.role === "manager" && data.city !== me.city) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const path = (data as Record<string, unknown>)[column] as string | null;
  if (!path) {
    // A row can legitimately have no photograph — most scans do not. Said
    // plainly rather than as an error, so the UI can distinguish "no photo was
    // taken" from "the photo could not be fetched".
    return NextResponse.json({ url: null, reason: "no photo on this record" });
  }

  // Ten minutes. Long enough to look at, short enough that a copied link is
  // not a lasting hole in evidence a person is identifiable in.
  const url = await signPhotoRead(admin, bucket, path, 600);
  if (!url) {
    return NextResponse.json({
      url: null,
      reason: "the photo is recorded but the file is missing from storage",
    });
  }
  return NextResponse.json({ url }, { headers: { "Cache-Control": "no-store" } });
}
