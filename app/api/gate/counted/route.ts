// GET /api/gate/counted?date=YYYY-MM-DD&city=DELHI — the items the gate counted
// but could not scan.
//
// WHY THIS ROUTE EXISTS AT ALL. Spare parts, consumables, PP boxes and samples
// carry no serial and never will: there is no sticker to scan, so a guard adds
// them by hand with a photograph and a quantity. lib/connectors/guard.ts then
// drops every one of them — `if (!barcode) continue` — because a row with no
// serial cannot enter a per-barcode ladder. That is right for the engine and it
// meant these movements reached NO screen in this tool. A guard photographed a
// pallet of PP boxes leaving the yard and the record went nowhere.
//
// So this is deliberately NOT read from the reconciliation run. It reads
// gate_scans directly, which also means the numbers are there for a day no run
// has covered yet.
//
// The date is a BUSINESS date (15:00→15:00 IST), matching the dashboard around
// it — not the guard app's calendar day.

import { NextResponse, type NextRequest } from "next/server";
import { jsonRoute } from "@/lib/api/json-route";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The counted family — no serial exists or is expected (migration 0041). */
const COUNTED_KINDS = ["spare_part", "consumable", "pp_box", "sample"];

export interface CountedItem {
  id: string;
  city: string;
  direction: string;
  scannedAt: string;
  itemKind: string;
  quantity: number;
  notes: string | null;
  /** Typed in by the guard rather than scanned — always true here, kept explicit. */
  entryMethod: string | null;
  hasPhoto: boolean;
  /** The registration as the guard or DT recorded it — never the folded key. */
  vehicleNo: string | null;
  agent: string | null;
  guard: string | null;
  /** The guard recorded it for a day before the one they were standing in. */
  recordedLate: boolean;
}

export const GET = jsonRoute("gate/counted", async (req: NextRequest) => {
  const me = await getCurrentAppUser();
  if (!me || (me.role !== "admin" && me.role !== "manager")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const sp = req.nextUrl.searchParams;
  const date = sp.get("date");
  if (!date) return NextResponse.json({ error: "date required" }, { status: 400 });
  // A manager is pinned to their own city whatever they ask for.
  const city = me.role === "manager" ? me.city : sp.get("city");

  const db = createAdminClient();
  let q = db
    .from("gate_scans")
    .select("id, city, direction, scanned_at, item_kind, quantity, notes, entry_method, photo_path, recorded_late, trip_id, guard_id")
    .eq("business_date", date)
    .eq("status", "recorded")
    .in("item_kind", COUNTED_KINDS)
    .is("barcode", null)
    .order("scanned_at", { ascending: true })
    .limit(1000);
  if (city && city !== "ALL") q = q.eq("city", city);

  const res = await q;
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
  const rows = (res.data ?? []) as Record<string, unknown>[];

  // The trip is what says which vehicle and which transport — a counted item on
  // its own is four boxes with no context, which is not worth opening.
  const tripIds = [...new Set(rows.map((r) => r.trip_id).filter((t): t is string => !!t))];
  const guardIds = [...new Set(rows.map((r) => r.guard_id).filter((g): g is string => !!g))];

  const [tripsRes, guardsRes] = await Promise.all([
    tripIds.length
      ? db.from("gate_trips").select("id, vehicle_no, driver_name").in("id", tripIds)
      : Promise.resolve({ data: [], error: null }),
    guardIds.length
      ? db.from("app_users").select("id, name").in("id", guardIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  type TripBits = { vehicle_no?: string | null; driver_name?: string | null };
  const trips = new Map<string, TripBits>();
  for (const t of (tripsRes.data ?? []) as Record<string, unknown>[]) {
    trips.set(t.id as string, t as TripBits);
  }
  const guards = new Map<string, string>();
  for (const g of (guardsRes.data ?? []) as { id: string; name: string | null }[]) {
    if (g.name) guards.set(g.id, g.name);
  }

  const items: CountedItem[] = rows.map((r) => {
    const t = r.trip_id ? trips.get(r.trip_id as string) : undefined;
    return {
      id: r.id as string,
      city: r.city as string,
      direction: (r.direction as string) ?? "",
      scannedAt: r.scanned_at as string,
      itemKind: (r.item_kind as string) ?? "",
      // Quantity is the whole record for these kinds; a null would be one item.
      quantity: (r.quantity as number) ?? 1,
      notes: (r.notes as string) ?? null,
      entryMethod: (r.entry_method as string) ?? null,
      hasPhoto: !!r.photo_path,
      vehicleNo: t?.vehicle_no ?? null,
      agent: t?.driver_name ?? null,
      guard: r.guard_id ? guards.get(r.guard_id as string) ?? null : null,
      recordedLate: !!r.recorded_late,
    };
  });

  const totals = items.reduce(
    (acc, i) => {
      if (i.direction === "IN") acc.in += i.quantity;
      else acc.out += i.quantity;
      return acc;
    },
    { in: 0, out: 0 }
  );

  return NextResponse.json({ date, city: city ?? "ALL", totals, items });
});
