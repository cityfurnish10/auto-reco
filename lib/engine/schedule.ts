// Weekly-off calendar — which warehouses are CLOSED on which weekday.
// Mumbai, Hyderabad and Pune take Thursday off; Gurgaon (DELHI in the app)
// and Bangalore run seven days. On an off day the floor sources (register,
// ops sheet, DT) are EXPECTED absent — dashboards show the city as OFF
// instead of implying a data gap, and the engine refuses to raise a
// "same-day movement" REAL from Odoo entries dated a day nothing could move.
//
// Pure and client-safe (no env, no db): server routes, the engine and the
// browser dashboards all derive OFF from the same (city, business_date) rule.

import type { City } from "../sample-data";

// JS Date#getUTCDay(): 0=Sun, 1=Mon, … 4=Thu, … 6=Sat.
export const WEEKLY_OFF_DAY: Partial<Record<City, number>> = {
  MUMBAI: 4,
  HYDERABAD: 4,
  PUNE: 4,
};

export const OFF_LABEL = "Weekly off";

// Is this city on its weekly holiday for the given IST business date?
export function isCityOff(city: City, businessDate: string): boolean {
  const off = WEEKLY_OFF_DAY[city];
  if (off === undefined) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate ?? "")) return false;
  const [y, m, d] = businessDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === off;
}

/**
 * Was this city shut for PART of the business window, without the window itself
 * being its off day?
 *
 * A business date is not a calendar day. Date D runs D 15:00 -> D+1 15:00 IST, so
 * it always straddles two calendar days, and a one-day closure therefore lands
 * inside TWO business dates:
 *
 *   business date Wed = Wed 15:00-24:00 (open) + Thu 00:00-15:00 (CLOSED)
 *   business date Thu = Thu 15:00-24:00 (CLOSED) + Fri 00:00-15:00 (open)
 *
 * isCityOff only sees the first of those, because it tests the weekday of the
 * date string. So the WEDNESDAY board shows Mumbai, Pune and Hyderabad with no
 * marker at all, even though the morning half of that window was a holiday —
 * which is exactly when their floor sources go quiet and their numbers stop being
 * comparable with Delhi's.
 *
 * Display only, deliberately. isCityOff still gates the engine, the leaderboard
 * and the trends: widening those would suppress real findings on a day the
 * warehouse genuinely worked for most of the window.
 */
export function closedPartOfWindow(city: City, businessDate: string): boolean {
  if (WEEKLY_OFF_DAY[city] === undefined) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate ?? "")) return false;
  if (isCityOff(city, businessDate)) return false; // already the strong "off" case
  const [y, m, d] = businessDate.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return isCityOff(city, next);
}
