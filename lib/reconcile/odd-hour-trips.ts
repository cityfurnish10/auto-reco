// A trip the gate opened at an hour this warehouse does not work.
//
// Owner's rule, 24 Sep 2026. Measured on the gate app, 1 Aug – 23 Sep 2026
// (265 trips, Delhi — the only city on the app):
//
//   OUTWARD   123 of 141 opened 09:00–11:59. Six after 6pm. ONE ever after
//             9pm, none between midnight and 8am.
//   INWARD    103 of 124 opened 18:00–21:59. Ten at 10–11pm. TWO ever after
//             midnight, none between 2am and 11am.
//
// Stock goes out in the morning and comes back in the evening; the reverse
// has effectively never happened. So an outward opened in the evening or the
// night, or an inward opened in the morning, is worth a person's attention
// every time — about four flags in two months at these windows.
//
// ONE ROW PER TRIP, not per unit (owner's choice). Every other variance in the
// system is one unit's disagreement between books; this one is a question
// about a trip — "who authorised this?" — and twenty rows would ask it twenty
// times. The row's `barcode` is therefore the trip's own id and its
// `barcode_display` is the vehicle number, which is what a manager will
// recognise. It is the only variance not produced by the per-barcode ladder,
// and the stale pass skips it for that reason (see persist.ts).
//
// ONLY WHERE THE GATE APP RUNS. A paper register carries no usable time, so
// four of the five cities cannot be checked this way until the app reaches
// them. Silence here is "not measurable", never "nothing happened".

import type { SupabaseClient } from "@supabase/supabase-js";
import type { City } from "../sample-data";
import { VARIANCE } from "../engine/variance-names";
import { VARIANCE_META } from "../engine/buckets";
import { varianceSource } from "../engine/variance-source";
import { gateAppCities } from "../connectors/guard";

type DB = SupabaseClient;

/** Hours (IST) in which each direction is unusual. Inclusive of the start. */
export const ODD_HOURS = {
  // Outward: evening and night. 20:00–07:59.
  OUT: (h: number) => h >= 20 || h < 8,
  // Inward: late night and the whole morning. 23:00–10:59.
  IN: (h: number) => h >= 23 || h < 11,
};

/** The IST hour and a readable clock for an instant. */
export function istHour(iso: string): { hour: number; clock: string } {
  const d = new Date(Date.parse(iso) + 5.5 * 3600_000);
  const hour = d.getUTCHours();
  const clock = `${String(hour).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return { hour, clock };
}

export interface TripLike {
  id: string;
  direction: string;
  vehicle_no: string | null;
  opened_at: string;
  city: string;
  guard_name?: string | null;
}

/** Pure: is this trip at an hour its direction rarely moves? */
export function isOddHour(trip: TripLike): boolean {
  const { hour } = istHour(trip.opened_at);
  if (trip.direction === "OUT") return ODD_HOURS.OUT(hour);
  if (trip.direction === "IN") return ODD_HOURS.IN(hour);
  return false;
}

export function noteFor(trip: TripLike, guardName?: string | null): string {
  const { clock } = istHour(trip.opened_at);
  const usual = trip.direction === "OUT" ? "9am to noon" : "6pm to 10pm";
  const who = guardName ? ` by ${guardName}` : "";
  return (
    `${trip.direction === "OUT" ? "Outward" : "Inward"} trip opened at ${clock}` +
    `${trip.vehicle_no ? ` on ${trip.vehicle_no}` : ""}${who}. ` +
    `${trip.direction === "OUT" ? "Outward" : "Inward"} movements almost always run ${usual}. ` +
    `Confirm who authorised this trip and that its stock is accounted for.`
  );
}

/**
 * Raise one variance per odd-hour trip opened on `runDate`.
 *
 * Upserts on the same natural key the engine uses, so a re-run refreshes
 * rather than duplicating, and a manager's close is never reopened (status and
 * first_seen_at are deliberately absent from the payload, as in upsertVariances).
 *
 * Best-effort: a failure here must never fail the run.
 */
export async function raiseOddHourTrips(
  db: DB,
  runId: string,
  runDate: string,
  warnings: string[]
): Promise<number> {
  try {
    const cities = gateAppCities(runDate);
    if (cities.size === 0) return 0;

    // The gate's own calendar day, in IST. A trip opened at 23:30 belongs to
    // the day it opened on — the same rule the gate page and the calendar-day
    // reconciliation use.
    const start = new Date(`${runDate}T00:00:00+05:30`).toISOString();
    const end = new Date(Date.parse(`${runDate}T00:00:00+05:30`) + 86_400_000).toISOString();

    const res = await db
      .from("gate_trips")
      .select("id, city, direction, vehicle_no, opened_at, guard_id, status")
      .gte("opened_at", start)
      .lt("opened_at", end)
      .in("city", [...cities]);
    if (res.error || !res.data?.length) return 0;

    const trips = (res.data as unknown as (TripLike & { guard_id: string | null; status: string })[])
      // An abandoned trip is not a movement; it is a guard who backed out.
      .filter((t) => t.status !== "abandoned")
      .filter(isOddHour);
    if (!trips.length) return 0;

    const guards = await db
      .from("app_users")
      .select("id, name")
      .in("id", [...new Set(trips.map((t) => t.guard_id).filter(Boolean))] as string[]);
    const nameOf = new Map((guards.data ?? []).map((g) => [g.id as string, g.name as string]));

    const meta = VARIANCE_META[VARIANCE.ODD_HOUR_TRIP];
    const now = new Date().toISOString();
    const payload = trips.map((t) => ({
      run_id: runId,
      business_date: runDate,
      city: t.city as City,
      // The trip is the unit here. Its id is stable across re-runs, so the
      // natural key upserts rather than duplicating.
      barcode: t.id,
      barcode_display: t.vehicle_no ?? t.id.slice(0, 8),
      direction: t.direction,
      variance_name: VARIANCE.ODD_HOUR_TRIP,
      note: noteFor(t, nameOf.get(t.guard_id ?? "")),
      variance_source: varianceSource(VARIANCE.ODD_HOUR_TRIP, t.direction as "IN" | "OUT"),
      priority: "High",
      bucket: meta.bucket,
      responsible: meta.responsible,
      date: runDate,
      last_seen_at: now,
      // Only the gate has anything to say about a trip, so it is the only book
      // shown as reporting. Four crosses would read as "three books missed this
      // unit", which is not what this row is about.
      present_p: true,
      reported_p: true,
      present_s: false,
      present_d: false,
      present_o: false,
      reported_s: false,
      reported_d: false,
      reported_o: false,
    }));

    const { error } = await db
      .from("variances")
      .upsert(payload, { onConflict: "business_date,city,direction,barcode,variance_name" });
    if (error) return 0;

    warnings.push(
      `${payload.length} trip${payload.length === 1 ? "" : "s"} opened at an hour the gate rarely sees — raised for confirmation`
    );
    return payload.length;
  } catch {
    return 0;
  }
}
