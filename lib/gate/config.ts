// Gate-app configuration: geofences, sampling, and the shared vocabulary the
// phone and the server must agree on.
//
// Kept in one module rather than scattered across routes because the app
// DOWNLOADS these values at bootstrap and then enforces them offline. If the
// server's idea of the sample rate and the phone's ever diverge, the phone
// wins for hours at a time — so there must be exactly one definition.

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
  lat: number;
  lng: number;
  radiusM: number;
}

export const GATE_SITES: GateSite[] = [
  { city: "DELHI",     siteCode: "GUR", label: "Gurugram",  lat: 28.4595, lng: 77.0266, radiusM: 300 },
  { city: "MUMBAI",    siteCode: "MUM", label: "Mumbai",    lat: 19.0760, lng: 72.8777, radiusM: 300 },
  { city: "PUNE",      siteCode: "PUN", label: "Pune",      lat: 18.5204, lng: 73.8567, radiusM: 300 },
  { city: "HYDERABAD", siteCode: "HYD", label: "Hyderabad", lat: 17.3850, lng: 78.4867, radiusM: 300 },
  { city: "BANGALORE", siteCode: "BAN", label: "Bangalore", lat: 12.9716, lng: 77.5946, radiusM: 300 },
];

export function siteFor(city: City): GateSite | undefined {
  return GATE_SITES.find((s) => s.city === city);
}

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
  city: City,
  lat: number | null | undefined,
  lng: number | null | undefined
): boolean | null {
  if (lat == null || lng == null) return null;
  const site = siteFor(city);
  if (!site) return null;
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
