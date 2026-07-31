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

// ─── the data-driven calendar ────────────────────────────────────────────────

/**
 * The closures actually configured in the delivery app, when we have them.
 *
 * WEEKLY_OFF_DAY above is a literal, written from a conversation. The delivery
 * app carries the same fact as editable ops data plus a holiday list — see
 * lib/connectors/warehouse-calendar.ts. Verified live: the two agree exactly on
 * the weekly rule for all five cities, so this is not a correction, it is a
 * source upgrade — and it brings 29 one-off closures the system has never known.
 *
 * Passed in rather than fetched, so every function here stays pure and usable
 * in the browser. Absent = fall back to the literal map, which is what a fresh
 * install, a Mongo outage or a pre-sync database all get.
 */
export interface ClosureCalendar {
  weeklyOff: Partial<Record<City, number[]>>;
  holidays: Partial<Record<City, string[]>>;
}

function weekdayOf(businessDate: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate ?? "")) return null;
  const [y, m, d] = businessDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Was this city shut on this business date — weekly off OR public holiday?
 *
 * Supersedes isCityOff wherever a calendar is available. isCityOff stays as the
 * pure, zero-argument form the engine and the browser already call in a dozen
 * places; this is the same question asked with better information.
 */
export function isCityClosed(
  city: City,
  businessDate: string,
  cal?: ClosureCalendar | null
): boolean {
  const wd = weekdayOf(businessDate);
  if (wd === null) return false;
  if (cal?.holidays?.[city]?.includes(businessDate)) return true;
  const weekly = cal?.weeklyOff?.[city];
  if (weekly) return weekly.includes(wd);
  return isCityOff(city, businessDate);
}

/** How far back lastWorkingDay will walk before giving up. */
const MAX_CLOSURE_RUN = 14;

/**
 * The most recent business date on or before `asOf` that this city worked.
 *
 * THIS IS THE WHOLE REGISTER-HANDOVER MODEL. A city hands over the register for
 * its own last working day, and that day differs per city: on a Friday, Delhi
 * and Bangalore hand over Thursday's book while Mumbai, Pune and Hyderabad —
 * shut on Thursday — hand over Wednesday's. Treating every city as if it owed
 * yesterday's register raises a missing-register alarm against three warehouses
 * every single week, on schedule, for a book nobody was ever going to hand over.
 *
 * Walks back rather than subtracting one, so a public holiday butting against
 * the weekly off (or two holidays in a row) resolves correctly. Bounded at
 * MAX_CLOSURE_RUN: a city closed a fortnight is a data problem, and returning
 * null says so instead of looping.
 */
export function lastWorkingDay(
  city: City,
  asOf: string,
  cal?: ClosureCalendar | null
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf ?? "")) return null;
  const start = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(start)) return null;
  for (let i = 0; i <= MAX_CLOSURE_RUN; i++) {
    const d = new Date(start - i * 86400_000).toISOString().slice(0, 10);
    if (!isCityClosed(city, d, cal)) return d;
  }
  return null;
}

/**
 * The first business date on or after `from` that this city works.
 * Same walk as lastWorkingDay, pointed forwards; same 14-day bound.
 */
export function nextWorkingDay(
  city: City,
  from: string,
  cal?: ClosureCalendar | null
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? "")) return null;
  const start = Date.parse(`${from}T00:00:00Z`);
  if (!Number.isFinite(start)) return null;
  for (let i = 0; i <= MAX_CLOSURE_RUN; i++) {
    const d = new Date(start + i * 86400_000).toISOString().slice(0, 10);
    if (!isCityClosed(city, d, cal)) return d;
  }
  return null;
}

/**
 * When the register for a business date is actually handed over.
 *
 * Date D's window shuts at 15:00 on D+1, so the guard rules the book off and
 * hands it over on D+1 — unless nobody is at the gate that day, in which case
 * it waits for the next day someone is. This is the ONE definition of "due";
 * every "+2 on the day before an off day" scattered through the email was an
 * approximation of it, and each of those approximations was wrong for a
 * holiday stacked against the weekly off.
 *
 *   registerDueOn(MUMBAI, Wed) = Fri   (Thu shut)
 *   registerDueOn(DELHI,  Thu) = Fri   (ordinary +1)
 */
export function registerDueOn(
  city: City,
  businessDate: string,
  cal?: ClosureCalendar | null
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate ?? "")) return null;
  const next = new Date(Date.parse(`${businessDate}T00:00:00Z`) + 86400_000)
    .toISOString()
    .slice(0, 10);
  return nextWorkingDay(city, next, cal);
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
