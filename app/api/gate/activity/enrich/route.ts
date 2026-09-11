// Look up the details of one trip's items now, rather than at the next
// scheduled run.
//
// A manager opens a trip right after the truck leaves; the job runs every two
// hours. Without this they saw bare barcodes on exactly the trips they were
// most likely to be asking about. Only the trip's own rows that have never been
// looked up are asked about, so reopening a trip costs nothing.

import { NextResponse, type NextRequest } from "next/server";
import { jsonRoute } from "@/lib/api/json-route";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { metabaseConfigured } from "@/lib/connectors/metabase";
import { enrichScans, isMissingColumn } from "@/lib/gate/enrich-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = jsonRoute("gate/activity/enrich", async (req: NextRequest) => {
  const me = await getCurrentAppUser();
  if (!me || (me.role !== "admin" && me.role !== "manager")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { tripId } = (await req.json().catch(() => ({}))) as { tripId?: string };
  if (!tripId) return NextResponse.json({ error: "tripId required" }, { status: 400 });
  if (!metabaseConfigured()) return NextResponse.json({ ok: true, skipped: "metabase not configured" });

  const db = createAdminClient();
  // The same city pin the Activity read applies: a manager cannot trigger
  // lookups on another city's trip by guessing its id.
  let trip = db.from("gate_trips").select("id").eq("id", tripId);
  if (me.role === "manager") trip = trip.eq("city", me.city);
  const t = await trip.maybeSingle();
  if (t.error) return NextResponse.json({ error: t.error.message }, { status: 500 });
  if (!t.data) return NextResponse.json({ error: "not found" }, { status: 404 });

  let dtReady = true;
  let res = await db.from("gate_scans").select("id,barcode,scanned_at,direction,enriched_at,task_checked_at")
    .eq("trip_id", tripId).eq("status", "recorded").limit(500);
  if (isMissingColumn(res.error)) {
    dtReady = false;
    res = await db.from("gate_scans").select("id,barcode,scanned_at,direction,enriched_at")
      .eq("trip_id", tripId).eq("status", "recorded").limit(500) as typeof res;
  }
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });

  const rows = (res.data ?? []) as { id: string; barcode: string | null; scanned_at: string; direction: string | null; enriched_at: string | null; task_checked_at?: string | null }[];
  const todo = rows
    .map((r) => ({ id: r.id, barcode: r.barcode, scannedAt: r.scanned_at, direction: r.direction, needsFacts: !r.enriched_at, needsTask: dtReady && !r.task_checked_at }))
    .filter((r) => r.needsFacts || r.needsTask);
  if (todo.length === 0) return NextResponse.json({ ok: true, considered: 0, dtReady });

  const outcome = await enrichScans(db, todo);
  return NextResponse.json({ ok: outcome.failed.length === 0, dtReady, ...outcome });
});
