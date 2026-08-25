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
  const sp = req.nextUrl.searchParams;
  const date = sp.get("date") ?? currentBusinessDate();
  // A manager is pinned to their own city whatever they ask for.
  const city = me.role === "manager" ? me.city : sp.get("city");
  const guardId = sp.get("guardId");
  const direction = sp.get("direction");

  let trips = admin.from("gate_trips")
    .select("id,client_trip_id,city,site_code,direction,vehicle_no,driver_name,carrier_ref," +
            "opened_at,closed_at,status,guard_id,app_users!guard_id(name)," +
            // What the completeness check found at close. Recorded since 0031
            // and, until now, visible to nobody — a gap the guard was shown and
            // a manager could not look up is not a control, it is a nag.
            "expected_checked_at,expected_total,expected_scanned,expected_missing," +
            "unplanned_count,expected_warned")
    .eq("business_date", date)
    .order("opened_at", { ascending: false });
  let scans = admin.from("gate_scans")
    .select("id,trip_id,barcode,serial_no,product,so_number,item_kind,quantity,entry_method,override_reason,exception_reason,barcode_pending,geo_ok,photo_path,scanned_at,guard_id")
    .eq("business_date", date).eq("status", "recorded")
    .order("scanned_at", { ascending: true }).limit(2000);

  if (city) { trips = trips.eq("city", city); scans = scans.eq("city", city); }
  if (guardId) { trips = trips.eq("guard_id", guardId); scans = scans.eq("guard_id", guardId); }
  if (direction) { trips = trips.eq("direction", direction); scans = scans.eq("direction", direction); }

  // Retractions, counted separately and never mixed into the item totals. A
  // voided row must not inflate what moved — that is the whole reason it is
  // voided — but a trip that had six items taken back is a trip worth opening,
  // and with this hidden entirely there was no way to notice.
  let removed = admin.from("gate_scans")
    .select("id,trip_id,barcode,serial_no,void_reason,voided_at")
    .eq("business_date", date).eq("status", "void")
    .order("voided_at", { ascending: true }).limit(500);
  if (city) removed = removed.eq("city", city);
  if (guardId) removed = removed.eq("guard_id", guardId);
  if (direction) removed = removed.eq("direction", direction);

  const [tr, sc, rm] = await Promise.all([trips, scans, removed]);
  if (tr.error) return NextResponse.json({ error: tr.error.message }, { status: 500 });
  if (sc.error) return NextResponse.json({ error: sc.error.message }, { status: 500 });
  // A failure to read retractions must not take the whole page down with it —
  // they are context, not the record.
  const removedRows = (rm.error ? [] : (rm.data ?? [])) as unknown as Record<string, unknown>[];

  // Cast once, here. Splitting the trip select across lines to fit the new
  // completeness columns lost Supabase's inferred row type, and casting at each
  // of the four use sites is how one of them quietly gets missed.
  const tripRows = (tr.data ?? []) as unknown as Record<string, unknown>[];
  const rows = (sc.data ?? []) as unknown as Record<string, unknown>[];
  const manual = rows.filter((r) => r.entry_method === "manual").length;

  // Who worked this day, for the filter — derived from the data rather than
  // the roster, so the dropdown only offers names that will return something.
  const guards = new Map<string, string>();
  for (const t of tripRows) {
    if (t.guard_id) guards.set(t.guard_id as string, (t.app_users as { name?: string })?.name ?? "");
  }

  return NextResponse.json({
    businessDate: date,
    totals: {
      trips: tripRows.length,
      items: rows.length,
      scanned: rows.length - manual,
      manual,
      overrides: rows.filter((r) => r.override_reason).length,
      awaitingBarcode: rows.filter((r) => r.barcode_pending).length,
      // The number the pilot is judged on: how much is scanned rather than typed.
      scannedShare: rows.length ? +(((rows.length - manual) / rows.length) * 100).toFixed(1) : null,
      removed: removedRows.length,
      // How often the plan and the truck disagreed. The figure that decides
      // whether the close-screen warning can be trusted enough to act on.
      tripsShort: tripRows
        .filter((t) => Array.isArray(t.expected_missing) && (t.expected_missing as unknown[]).length > 0).length,
      tripsChecked: tripRows.filter((t) => t.expected_checked_at).length,
    },
    guards: [...guards].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    trips: tripRows.map((x) => {
      const items = rows.filter((r) => r.trip_id === x.id);
      const secs = x.closed_at
        ? Math.round((Date.parse(x.closed_at as string) - Date.parse(x.opened_at as string)) / 1000)
        : null;
      return {
        id: x.id, direction: x.direction, vehicleNo: x.vehicle_no,
        driverName: x.driver_name, carrierRef: x.carrier_ref,
        city: x.city, siteCode: x.site_code,
        openedAt: x.opened_at, closedAt: x.closed_at, status: x.status,
        durationSec: secs,
        guardName: (x.app_users as { name?: string })?.name ?? "",
        itemCount: items.length,
        overrides: items.filter((i) => i.override_reason).length,
        manual: items.filter((i) => i.entry_method === "manual").length,
        // Taken back by the guard. Not part of itemCount — a voided row must
        // never inflate what moved — but shown, because six retractions on one
        // trip is a trip worth opening.
        removed: removedRows
          .filter((r) => r.trip_id === x.id)
          .map((r) => ({
            barcode: (r.barcode as string) ?? (r.serial_no as string) ?? null,
            reason: (r.void_reason as string) ?? null,
            at: r.voided_at as string,
          })),
        // What the completeness check found when the trip closed. Null on any
        // trip that predates the check, or closed with no list to check
        // against — deliberately distinct from "nothing was missing".
        completeness: x.expected_checked_at ? {
          total: (x.expected_total as number) ?? 0,
          scanned: (x.expected_scanned as number) ?? 0,
          missing: (x.expected_missing as string[]) ?? [],
          unplanned: (x.unplanned_count as number) ?? 0,
          // False through the silent period. Kept so the false-alarm rate is
          // never measured against guards who were shown nothing.
          warned: !!x.expected_warned,
        } : null,
        items: items.map((r) => ({
          id: r.id,
          // The RAW scanned spelling, never the fold — that is the point of the
          // whole scanning project.
          barcode: (r.barcode as string) ?? null,
          serialNo: r.serial_no, product: r.product, soNumber: r.so_number,
          itemKind: r.item_kind, quantity: r.quantity,
          entryMethod: r.entry_method,
          override: r.override_reason ?? null,
          exception: r.exception_reason ?? null,
          awaitingBarcode: r.barcode_pending,
          geoOk: r.geo_ok, hasPhoto: !!r.photo_path,
          scannedAt: r.scanned_at,
        })),
      };
    }),
  });
}
