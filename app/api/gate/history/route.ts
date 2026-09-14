// GET /api/gate/history?guardId=&date= — what this guard recorded on a day.
//
// Scoped to the guard who asks, by decision: a guard sees their own work.
// Anything wider is a supervisor's view and lives in the dashboard.
//
// Device-token authenticated like the rest of the gate API, and the guard is
// checked against the device's own city before anything is returned.

import { NextResponse, type NextRequest } from "next/server";
import { jsonRoute } from "@/lib/api/json-route";
import { createAdminClient } from "@/lib/supabase/admin";
import { identifyDevice, withGuard } from "@/lib/gate/auth";
import { istDayRange, istToday, isIsoDate } from "@/lib/gate/calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = jsonRoute("gate/history", async (req: NextRequest) => {
  const admin = createAdminClient();
  const device = await identifyDevice(admin, req.headers.get("authorization"));
  if (!device) return NextResponse.json({ error: "unknown or revoked device" }, { status: 401 });

  const who = await withGuard(admin, device, req.nextUrl.searchParams.get("guardId"));
  if (!who) return NextResponse.json({ error: "no active guard" }, { status: 403 });

  // A CALENDAR day (IST), by when each trip was opened — the guard's own
  // meaning of "the 13th". Items follow their trip, so a truck opened at 23:50
  // keeps its 00:05 scans rather than splitting across two days.
  const qd = req.nextUrl.searchParams.get("date");
  const date = isIsoDate(qd) ? qd : istToday();
  const { from, to } = istDayRange(date);

  // Same rule as Activity: a trip recorded for yesterday (0044) is on yesterday.
  const base = "id,client_trip_id,direction,vehicle_no,driver_name,opened_at,closed_at,status";
  let trips = await admin.from("gate_trips")
    .select(base + ",movement_date,recorded_late")
    .eq("guard_id", who.guardId)
    .or(`and(opened_at.gte.${from},opened_at.lt.${to},movement_date.is.null),movement_date.eq.${date}`)
    .order("opened_at", { ascending: false });
  if (trips.error?.code === "42703") {
    trips = await admin.from("gate_trips").select(base)
      .eq("guard_id", who.guardId).gte("opened_at", from).lt("opened_at", to)
      .order("opened_at", { ascending: false }) as typeof trips;
  }
  if (trips.error) return NextResponse.json({ error: trips.error.message }, { status: 500 });
  const tripIds = (trips.data ?? []).map((t) => (t as unknown as Record<string, unknown>).id as string);
  const scans = tripIds.length
    ? await admin.from("gate_scans")
        .select("id,client_scan_id,trip_id,barcode,serial_no,item_kind,quantity,entry_method,override_reason,notes,scanned_at")
        .in("trip_id", tripIds).eq("status", "recorded")
        .order("scanned_at", { ascending: true })
    : { data: [] as Record<string, unknown>[], error: null };

  const rows = (scans.data ?? []) as Record<string, unknown>[];
  return NextResponse.json({
    date,
    totals: { trips: (trips.data ?? []).length, items: rows.length },
    trips: (trips.data ?? []).map((t) => {
      const x = t as unknown as Record<string, unknown>;
      const items = rows.filter((r) => r.trip_id === x.id);
      return {
        id: x.id, clientTripId: x.client_trip_id, direction: x.direction, vehicleNo: x.vehicle_no,
        driverName: x.driver_name, openedAt: x.opened_at, closedAt: x.closed_at,
        status: x.status, itemCount: items.length,
        items: items.map((r) => ({
          barcode: (r.barcode as string) ?? (r.serial_no as string) ?? null,
          // The phone's own id for the row. Lets a phone that reloaded mid-trip
          // rebuild the items it has ALREADY SENT, and retract one by voiding it.
          clientScanId: r.client_scan_id,
          notes: (r.notes as string) ?? null,
          itemKind: r.item_kind, quantity: r.quantity,
          entryMethod: r.entry_method, override: !!r.override_reason,
          scannedAt: r.scanned_at,
        })),
      };
    }),
  });
});
