// GET /api/gate/history?guardId=&date= — what this guard recorded on a day.
//
// Scoped to the guard who asks, by decision: a guard sees their own work.
// Anything wider is a supervisor's view and lives in the dashboard.
//
// Device-token authenticated like the rest of the gate API, and the guard is
// checked against the device's own city before anything is returned.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { identifyDevice, withGuard } from "@/lib/gate/auth";
import { currentBusinessDate } from "@/lib/reconcile/cron-dates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const admin = createAdminClient();
  const device = await identifyDevice(admin, req.headers.get("authorization"));
  if (!device) return NextResponse.json({ error: "unknown or revoked device" }, { status: 401 });

  const who = await withGuard(admin, device, req.nextUrl.searchParams.get("guardId"));
  if (!who) return NextResponse.json({ error: "no active guard" }, { status: 403 });

  const date = req.nextUrl.searchParams.get("date") ?? currentBusinessDate();

  const [trips, scans] = await Promise.all([
    admin.from("gate_trips")
      .select("id,client_trip_id,direction,vehicle_no,driver_name,opened_at,closed_at,status")
      .eq("guard_id", who.guardId).eq("business_date", date)
      .order("opened_at", { ascending: false }),
    admin.from("gate_scans")
      .select("id,trip_id,barcode,serial_no,item_kind,quantity,entry_method,override_reason,scanned_at")
      .eq("guard_id", who.guardId).eq("business_date", date).eq("status", "recorded")
      .order("scanned_at", { ascending: true }),
  ]);
  if (trips.error) return NextResponse.json({ error: trips.error.message }, { status: 500 });

  const rows = (scans.data ?? []) as Record<string, unknown>[];
  return NextResponse.json({
    date,
    totals: { trips: (trips.data ?? []).length, items: rows.length },
    trips: (trips.data ?? []).map((t) => {
      const x = t as Record<string, unknown>;
      const items = rows.filter((r) => r.trip_id === x.id);
      return {
        id: x.id, direction: x.direction, vehicleNo: x.vehicle_no,
        driverName: x.driver_name, openedAt: x.opened_at, closedAt: x.closed_at,
        status: x.status, itemCount: items.length,
        items: items.map((r) => ({
          barcode: (r.barcode as string) ?? (r.serial_no as string) ?? null,
          itemKind: r.item_kind, quantity: r.quantity,
          entryMethod: r.entry_method, override: !!r.override_reason,
          scannedAt: r.scanned_at,
        })),
      };
    }),
  });
}
