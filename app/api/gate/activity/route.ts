// What the gate has actually recorded — the manager's view of the app's output.
//
// Deliberately answers the questions a manager asks in the pilot, not a generic
// row dump: is it capturing everything, how much is typed rather than scanned,
// and how often is somebody overriding.

import { NextResponse, type NextRequest } from "next/server";
import { jsonRoute } from "@/lib/api/json-route";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { istDateOf, istDayRange, istToday, isIsoDate } from "@/lib/gate/calendar";
import { agentKey, commonestSpelling, transportKey } from "@/lib/gate/transport";
import { findDuplicates } from "@/lib/gate/duplicates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = jsonRoute("gate/activity", async (req: NextRequest) => {
  const me = await getCurrentAppUser();
  if (!me || (me.role !== "admin" && me.role !== "manager")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const admin = createAdminClient();
  const sp = req.nextUrl.searchParams;
  // A CALENDAR day (IST), by when each trip was opened. Not the warehouse day
  // (15:00 → 15:00) the reconciliation uses — "Activity for 13.09" was showing
  // trucks that left on the morning of the 14th. Items follow their trip.
  const qd = sp.get("date");
  const date = isIsoDate(qd) ? qd : istToday();
  const { from, to } = istDayRange(date);
  // A manager is pinned to their own city whatever they ask for.
  const city = me.role === "manager" ? me.city : sp.get("city");
  const guardId = sp.get("guardId");
  const direction = sp.get("direction");
  // Matched on the registration and on the name case-insensitively, never on the
  // raw text: one truck reached the gate under up to four spellings in a week.
  const vehicle = sp.get("vehicle");
  const agent = sp.get("agent");

  let trips = admin.from("gate_trips")
    .select("id,client_trip_id,city,site_code,direction,vehicle_no,driver_name,carrier_ref," +
            "opened_at,closed_at,status,guard_id,app_users!guard_id(name)," +
            // What the completeness check found at close. Recorded since 0031
            // and, until now, visible to nobody — a gap the guard was shown and
            // a manager could not look up is not a control, it is a nag.
            "expected_checked_at,expected_total,expected_scanned,expected_missing," +
            "unplanned_count,expected_warned")
    .gte("opened_at", from).lt("opened_at", to)
    .order("opened_at", { ascending: false });
  // unit_* and last_* are DERIVED (migration 0037) — Odoo's answer to "what is
  // this serial". task_* are DERIVED too (0039) — the unit's latest DT task,
  // which is where ticket, job type and the real customer live. All shown so a
  // manager sees the register row rather than a bare number; all deliberately
  // separate from product/so_number, which are the gate's own testimony.
  const SCAN_COLS = "id,trip_id,city,direction,business_date,barcode,serial_no,product,so_number,ticket_id,customer,item_kind,quantity,entry_method,override_reason,exception_reason,barcode_pending,geo_ok,photo_path,scanned_at,guard_id,notes,unit_product,unit_sku,last_customer,last_so,last_moved_at";
  const TASK_COLS = ",task_ticket,task_job_type,task_customer,task_so,task_city,task_checked_at,enriched_at";
  // The day's trips first — ALL of them in the city. Guard and direction are
  // applied afterwards, because a duplicate is judged against the whole day and
  // the entry it repeats may sit on another guard's trip.
  if (city) trips = trips.eq("city", city);
  const tr = await trips;
  if (tr.error) return NextResponse.json({ error: tr.error.message }, { status: 500 });
  const dayTrips = (tr.data ?? []) as unknown as Record<string, unknown>[];
  const dayTripIds = dayTrips.map((t) => t.id as string);
  const NONE = "00000000-0000-0000-0000-000000000000";

  const scansQuery = (cols: string) => admin.from("gate_scans").select(cols)
    .in("trip_id", dayTripIds.length ? dayTripIds : [NONE]).eq("status", "recorded")
    .order("scanned_at", { ascending: true }).limit(5000);
  const MATCH_COLS = ",task_date,task_matched";
  let scans = scansQuery(SCAN_COLS + TASK_COLS + MATCH_COLS);

  // Retractions, counted separately and never mixed into the item totals. A
  // voided row must not inflate what moved — that is the whole reason it is
  // voided — but a trip that had six items taken back is a trip worth opening,
  // and with this hidden entirely there was no way to notice.
  const removed = admin.from("gate_scans")
    .select("id,trip_id,guard_id,direction,barcode,serial_no,void_reason,voided_at")
    .in("trip_id", dayTripIds.length ? dayTripIds : [NONE]).eq("status", "void")
    .order("voided_at", { ascending: true }).limit(1000);

  let [sc, rm] = await Promise.all([scans, removed]);
  // 0039 applied by hand, possibly not yet: without its columns, show what 0037
  // gave rather than failing the whole Activity page over a lookup.
  if (sc.error?.code === "42703") { scans = scansQuery(SCAN_COLS + TASK_COLS); sc = await scans; }
  if (sc.error?.code === "42703") { scans = scansQuery(SCAN_COLS + ",enriched_at"); sc = await scans; }
  if (sc.error?.code === "42703") { scans = scansQuery(SCAN_COLS); sc = await scans; }
  if (sc.error) return NextResponse.json({ error: sc.error.message }, { status: 500 });
  // A failure to read retractions must not take the whole page down with it —
  // they are context, not the record.
  const removedRows = ((rm.error ? [] : (rm.data ?? [])) as unknown as Record<string, unknown>[])
    .filter((r) => (!guardId || r.guard_id === guardId) && (!direction || r.direction === direction));

  // Cast once, here. Splitting the trip select across lines to fit the new
  // completeness columns lost Supabase's inferred row type, and casting at each
  // of the four use sites is how one of them quietly gets missed.
  const allTrips = dayTrips.filter((t) =>
    (!guardId || t.guard_id === guardId) && (!direction || t.direction === direction));

  // Dropdown options come from the day BEFORE the transport and agent filters,
  // so choosing one truck does not empty the list of the others.
  const optionList = (pick: (t: Record<string, unknown>) => string | null, keyOf: (v: string) => string) => {
    const spellings = new Map<string, string[]>();
    for (const t of allTrips) {
      const v = pick(t);
      if (!v || !v.trim()) continue;
      const k = keyOf(v);
      if (k) spellings.set(k, [...(spellings.get(k) ?? []), v.trim()]);
    }
    return [...spellings].map(([key, all]) => ({ key, label: commonestSpelling(all), trips: all.length }))
      .sort((a, b) => a.label.localeCompare(b.label));
  };
  const vehicles = optionList((t) => t.vehicle_no as string, transportKey);
  const agents = optionList((t) => t.driver_name as string, agentKey);

  const tripRows = allTrips.filter((t) =>
    (!vehicle || transportKey(t.vehicle_no as string) === vehicle) &&
    (!agent || agentKey(t.driver_name as string) === agent));
  const keptTrips = new Set(tripRows.map((t) => t.id));
  const narrowed = !!(vehicle || agent);
  const dayScans = (sc.data ?? []) as unknown as Record<string, unknown>[];
  const duplicates = findDuplicates(dayScans.map((r) => ({
    id: r.id as string, tripId: (r.trip_id as string) ?? null, city: (r.city as string) ?? null,
    // Same calendar day as everything else on this screen.
    businessDate: istDateOf(r.scanned_at as string), direction: (r.direction as string) ?? null,
    barcode: (r.barcode as string) ?? null, serialNo: (r.serial_no as string) ?? null,
    soNumber: (r.so_number as string) ?? null, ticketId: (r.ticket_id as string) ?? null,
    itemKind: (r.item_kind as string) ?? null, quantity: (r.quantity as number) ?? null,
    notes: (r.notes as string) ?? null, scannedAt: r.scanned_at as string,
  })));
  // Every entry on the chosen trips, duplicates included so they can be SEEN…
  const rows = dayScans
    .filter((r) => (!guardId || r.guard_id === guardId) && (!direction || r.direction === direction))
    .filter((r) => !narrowed || keptTrips.has(r.trip_id));
  // …and only the unique ones COUNTED, anywhere a number is shown.
  const counted = rows.filter((r) => !duplicates.has(r.id as string));
  const manual = counted.filter((r) => r.entry_method === "manual").length;

  // Who worked this day, for the filter — derived from the data rather than
  // the roster, so the dropdown only offers names that will return something.
  const guards = new Map<string, string>();
  for (const t of dayTrips) {
    if (t.guard_id) guards.set(t.guard_id as string, (t.app_users as { name?: string })?.name ?? "");
  }

  return NextResponse.json({
    // Named businessDate for the page that reads it; it is the CALENDAR day.
    businessDate: date,
    calendarDay: true,
    totals: {
      trips: tripRows.length,
      items: counted.length,
      scanned: counted.length - manual,
      manual,
      overrides: counted.filter((r) => r.override_reason).length,
      awaitingBarcode: counted.filter((r) => r.barcode_pending).length,
      // The number the pilot is judged on: how much is scanned rather than typed.
      scannedShare: counted.length ? +(((counted.length - manual) / counted.length) * 100).toFixed(1) : null,
      // Left out of every figure above, shown on the trips they belong to.
      duplicates: rows.length - counted.length,
      removed: removedRows.filter((r) => !narrowed || keptTrips.has(r.trip_id)).length,
      // How often the plan and the truck disagreed. The figure that decides
      // whether the close-screen warning can be trusted enough to act on.
      tripsShort: tripRows
        .filter((t) => Array.isArray(t.expected_missing) && (t.expected_missing as unknown[]).length > 0).length,
      tripsChecked: tripRows.filter((t) => t.expected_checked_at).length,
    },
    guards: [...guards].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    vehicles,
    agents,
    trips: tripRows.map((x) => {
      const items = rows.filter((r) => r.trip_id === x.id);
      const unique = items.filter((r) => !duplicates.has(r.id as string));
      const secs = x.closed_at
        ? Math.round((Date.parse(x.closed_at as string) - Date.parse(x.opened_at as string)) / 1000)
        : null;
      return {
        id: x.id, direction: x.direction, vehicleNo: x.vehicle_no,
        transportKey: transportKey(x.vehicle_no as string),
        driverName: x.driver_name, carrierRef: x.carrier_ref,
        city: x.city, siteCode: x.site_code,
        openedAt: x.opened_at, closedAt: x.closed_at, status: x.status,
        durationSec: secs,
        guardName: (x.app_users as { name?: string })?.name ?? "",
        itemCount: unique.length,
        overrides: unique.filter((i) => i.override_reason).length,
        manual: unique.filter((i) => i.entry_method === "manual").length,
        duplicates: items.length - unique.length,
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
          // The register row. Witnessed values first, then the DT task matched
          // to THIS movement. Deliberately NOT Odoo's last_so / last_customer:
          // those are the unit's last known movement, which can be months old
          // (FUL5ZA24120009's was a March transfer), and a stale value in a row
          // labelled with today's trip reads as a fact about today. Item name
          // is the exception — what a unit IS does not go out of date.
          itemName: (r.product as string) ?? (r.unit_product as string) ?? null,
          soDisplay: (r.so_number as string) ?? (r.task_so as string) ?? null,
          // Whether the task details are THIS movement's or the unit's last
          // known ones (no task near the scan date). Rows written before 0040
          // carry no flag and are treated as unlabelled — they are reset by it.
          taskDate: (r.task_date as string) ?? null,
          lastKnown: r.task_matched === false,
          ticket: (r.ticket_id as string) ?? (r.task_ticket as string) ?? null,
          customer: (r.customer as string) ?? (r.task_customer as string) ?? null,
          jobType: (r.task_job_type as string) ?? null,
          // Whether a lookup is still owed, so the screen can say "looking up"
          // rather than a dash that reads as "there is nothing".
          lookupPending: ("enriched_at" in r && !r.enriched_at) || ("task_checked_at" in r && !r.task_checked_at),
          itemKind: r.item_kind, quantity: r.quantity,
          // The guard's own description. On a hand entry it is often the only
          // thing saying what the item is ("WM -10 QTY") and was shown nowhere.
          notes: (r.notes as string) ?? null,
          // Not counted: repeats an earlier entry (lib/gate/duplicates.ts).
          duplicateOf: duplicates.get(r.id as string) ?? null,
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
});
