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
