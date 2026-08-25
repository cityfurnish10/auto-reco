// Gate-app configuration: geofences, sampling, and the shared vocabulary the
// phone and the server must agree on.
//
// Kept in one module rather than scattered across routes because the app
// DOWNLOADS these values at bootstrap and then enforces them offline. If the
// server's idea of the sample rate and the phone's ever diverge, the phone
// wins for hours at a time — so there must be exactly one definition.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { City } from "../sample-data";
import type { GateItemKind } from "../db/schema";

/**
 * Where each gate physically is.
 *
 * NCR runs ONE warehouse (Gurugram) serving Gurgaon, Noida, Faridabad,
 * Ghaziabad and Delhi — confirmed with operations 2026-08-21. Odoo nonetheless
 * carries separate codes GUR/GGN/NOI that all fold into the DELHI bucket, which
 * is why every row still records its site: if a second NCR site ever activates,
 * the history is already there.
 *
 * Coordinates are placeholders until the real ones land. `radiusM` is generous
 * on purpose — a phone against a metal shutter drifts badly, and a false
 * "outside the gate" is far more damaging than a loose boundary: it teaches the
 * guard the location check is noise.
 */
export interface GateSite {
  city: City;
  siteCode: string;
  label: string;
  address: string | null;
  serves: string | null;
  /** Null until somebody stands at the gate and pins it. */
  lat: number | null;
  lng: number | null;
  radiusM: number;
}

/**
 * The gates, read from the database (migration 0026) rather than compiled in.
 *
 * They were constants, and the constants were placeholders -- which is why
 * every scan so far recorded geo_ok = false. Geocoding the postal address does
 * not fix it either: the address resolves to the centre of the village, over a
 * kilometre from the building, and a geofence built on that looks right while
 * rejecting honest work. A manager pins it from the gate instead.
 */
export async function loadSites(db: SupabaseClient): Promise<GateSite[]> {
  const { data, error } = await db
    .from("gate_sites")
    .select("city,site_code,label,address,serves,lat,lng,radius_m");
  if (error || !data) return [];
  return data.map((r) => ({
    city: r.city as City,
    siteCode: r.site_code as string,
    label: r.label as string,
    address: (r.address as string) ?? null,
    serves: (r.serves as string) ?? null,
    lat: (r.lat as number) ?? null,
    lng: (r.lng as number) ?? null,
    radiusM: (r.radius_m as number) ?? 400,
  }));
}

export async function loadSite(db: SupabaseClient, city: City): Promise<GateSite | null> {
  return (await loadSites(db)).find((s) => s.city === city) ?? null;
}

/** Site code without a round trip — the codes are fixed and mirror Odoo's. */
const SITE_CODES: Record<City, string> = {
  DELHI: "GUR", MUMBAI: "MUM", PUNE: "PUN", HYDERABAD: "HYD", BANGALORE: "BAN",
};
export const siteCodeFor = (city: City) => SITE_CODES[city];

/**
 * Share of clean outward scans drawn for a photo spot-check.
 *
 * Not 100%: at ~740 units/day a forced photo adds ~5 minutes per truck and
 * works directly against the turnaround goal, while proving little — one chest
 * of drawers photographs like every other one, and the QR read off the item is
 * stronger identity evidence than the picture. Because the guard cannot predict
 * which items are drawn, the deterrent survives at a tenth of the cost.
 */
export const OUTWARD_PHOTO_SAMPLE_RATE = 0.1;

/**
 * Whether the expected-list check is shown to the guard, or only recorded.
 *
 * FALSE through the pilot. Every scan still stores what the check WOULD have
 * said, so the false-alarm rate can be measured against real traffic before any
 * guard is shown a warning — the expected list is built from Odoo planned
 * pickings, and nobody has yet verified those are populated before the goods
 * move. Training people to dismiss warnings is far more expensive than
 * launching the warning late.
 */
export const EXPECTED_CHECK_LIVE = false;

/**
 * Does the CLOSE screen tell the guard what the plan still expects?
 *
 * Separate from EXPECTED_CHECK_LIVE above, and the two are not the same
 * decision. That one interrupts a SCAN: the guard is stopped mid-flow, made to
 * pick a reason and take a photograph, with a driver waiting. This one is a
 * list at the end of a trip the guard has already finished, next to a button
 * that adds anything they find. One costs seconds per item and a lot of
 * goodwill; the other costs a glance.
 *
 * TRUE, because operations asked for the guard to be told before ending a trip,
 * and because a gap they can still fix in the next thirty seconds is worth far
 * more than the same gap discovered at midnight by reconciliation.
 *
 * THE RISK, stated plainly: the expected list is built from Odoo planned
 * pickings and its quality is not yet proven. If it turns out thin, this panel
 * will cry wolf on every trip and guards will learn to scroll past it. That is
 * why it is one constant and not woven through the app — if the first days are
 * noisy, set it false, keep collecting silently, and turn it back on when the
 * data earns it. gate_completeness_daily is the view that answers whether it has.
 */
export const COMPLETENESS_SHOWN = true;

/** Metres between two coordinates. Haversine; good to a few cm at this scale. */
export function distanceM(
  aLat: number, aLng: number, bLat: number, bLng: number
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Did this fix fall inside the gate?
 *
 * `null` — not false — when there is no fix or no configured site. A phone
 * indoors often cannot get one, and treating "unknown" as "outside" would
 * flag honest work. Absence of evidence is recorded as absence, not as failure.
 */
export function geoOk(
  site: GateSite | null | undefined,
  lat: number | null | undefined,
  lng: number | null | undefined
): boolean | null {
  // Null, never false, in all three "we cannot tell" cases: no fix from the
  // phone, no gate pinned yet, or no site configured. Recording "unknown" as
  // "outside the gate" would flag honest work and teach everyone to ignore it.
  if (lat == null || lng == null) return null;
  if (!site || site.lat == null || site.lng == null) return null;
  return distanceM(lat, lng, site.lat, site.lng) <= site.radiusM;
}

/** Kinds with no serial — the quantity is the entire record. */
export const COUNTED_KINDS: readonly GateItemKind[] = [
  "spare_part", "consumable", "pp_box", "sample",
];
export const isCounted = (k: GateItemKind) => COUNTED_KINDS.includes(k);

/** Inward-only kinds. Neither can leave: what goes out is a unit or an extra. */
export const INWARD_ONLY_KINDS: readonly GateItemKind[] = [
  "vendor_goods", "customer_return",
];
