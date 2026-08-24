// What the gate has actually recorded — the manager's view of the app's output.
//
// Deliberately answers the questions a manager asks in the pilot, not a generic
// row dump: is it capturing everything, how much is typed rather than scanned,
// and how often is somebody overriding.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { currentBusinessDate } from "@/lib/reconcile/cron-dates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const me = await getCurrentAppUser();
  if (!me || (me.role !== "admin" && me.role !== "manager")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const admin = createAdminClient();
  const date = req.nextUrl.searchParams.get("date") ?? currentBusinessDate();
  const city = me.role === "manager" ? me.city : req.nextUrl.searchParams.get("city");

  let scans = admin.from("gate_scans")
    .select("id,city,direction,barcode,item_kind,quantity,entry_method,override_reason,barcode_pending,scanned_at,guard_id,trip_id,app_users!guard_id(name)")
    .eq("business_date", date).eq("status", "recorded")
    .order("scanned_at", { ascending: false }).limit(500);
  let trips = admin.from("gate_trips")
    .select("id,client_trip_id,city,direction,vehicle_no,opened_at,closed_at,status,guard_id,app_users!guard_id(name)")
    .eq("business_date", date).order("opened_at", { ascending: false });
  if (city) { scans = scans.eq("city", city); trips = trips.eq("city", city); }

  const [s, tr] = await Promise.all([scans, trips]);
  if (s.error) return NextResponse.json({ error: s.error.message }, { status: 500 });

  const rows = (s.data ?? []) as Record<string, unknown>[];
  const manual = rows.filter((r) => r.entry_method === "manual").length;
  const overrides = rows.filter((r) => r.override_reason).length;

  return NextResponse.json({
    businessDate: date,
    totals: {
      items: rows.length,
      trips: (tr.data ?? []).length,
      scanned: rows.length - manual,
      manual,
      overrides,
      awaitingBarcode: rows.filter((r) => r.barcode_pending).length,
      // The number the pilot is actually judged on.
      scannedShare: rows.length ? +(((rows.length - manual) / rows.length) * 100).toFixed(1) : null,
    },
    trips: (tr.data ?? []).map((t) => {
      const x = t as Record<string, unknown>;
      return {
        id: x.id, clientTripId: x.client_trip_id, direction: x.direction,
        vehicleNo: x.vehicle_no, openedAt: x.opened_at, closedAt: x.closed_at,
        status: x.status, guardName: (x.app_users as { name?: string })?.name ?? "",
        items: rows.filter((r) => r.trip_id === x.id).length,
      };
    }),
    scans: rows.slice(0, 200).map((r) => ({
      id: r.id, direction: r.direction, barcode: r.barcode, itemKind: r.item_kind,
      quantity: r.quantity, entryMethod: r.entry_method, override: !!r.override_reason,
      awaitingBarcode: r.barcode_pending, scannedAt: r.scanned_at,
      guardName: (r.app_users as { name?: string })?.name ?? "",
    })),
  });
}
