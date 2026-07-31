// Which warehouses are shut, and when — read from the delivery app's own
// master data rather than hardcoded here.
//
// WHY THIS EXISTS. lib/engine/schedule.ts carries WEEKLY_OFF_DAY as a literal
// map, written from what somebody said in a conversation. The delivery app has
// carried the same fact as EDITABLE OPS DATA all along, in the `master_datas`
// collection, and nobody had looked:
//
//   master = "weekly_off"   34 rows  { city, "week day": "Thu", status: bool }
//   master = "holiday"      29 rows  { date: "d/m/yyyy", city: [..], status }
//   master = "working_hours" 14 rows { city, start_time, end_time }
//
// Verified live 2026-07-31 against the five cities we reconcile: Pune, Mumbai
// and Hyderabad carry an ACTIVE Thursday rule; Gurgaon and Bangalore carry the
// same row with status=false. That is exactly WEEKLY_OFF_DAY, which means the
// hardcoded map was right — and also means it can now stop being hardcoded, so
// an ops change in the app reaches this system without a deploy.
//
// The holiday table is the real prize: 29 one-off closures the reconciler has
// never known about, including dates where a city was shut and every floor
// source correctly went quiet while we called it a missing register.
//
// `status` IS THE ACTIVE FLAG, not a closure flag. A weekly_off row with
// status=false is a rule that has been switched off, not a day the warehouse
// worked; the same field means the same thing on both masters.

import { MongoClient } from "mongodb";
import type { City } from "../sample-data";
import { normalizeCity } from "./types";

/** JS getUTCDay(): 0=Sun … 6=Sat. Matches WEEKLY_OFF_DAY's convention. */
const WEEKDAY_INDEX: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

export interface WarehouseCalendar {
  /** Weekday numbers a city is closed every week. */
  weeklyOff: Partial<Record<City, number[]>>;
  /** One-off closures, as ISO yyyy-mm-dd. */
  holidays: Partial<Record<City, string[]>>;
}

export const EMPTY_CALENDAR: WarehouseCalendar = { weeklyOff: {}, holidays: {} };

/**
 * "26/1/2026" -> "2026-01-26".
 *
 * DAY FIRST. The rows include 26/1/2026 and 15/8/2025 — Republic Day and
 * Independence Day — which pin the order beyond argument. Reading them
 * month-first would place Republic Day in December and silently shift a
 * closure onto the wrong date.
 */
export function parseDmy(raw: unknown): string | null {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(String(raw ?? ""));
  if (!m) return null;
  const [, d, mo, y] = m;
  const day = Number(d);
  const month = Number(mo);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

interface MasterRow {
  city?: unknown;
  status?: unknown;
  date?: unknown;
  ["week day"]?: unknown;
}

/**
 * Fold the raw master rows into a calendar. Pure, so every rule below is a unit
 * test with no database.
 *
 * ONE CITY, SEVERAL WAREHOUSES. Gurgaon and Noida both normalise to DELHI, and
 * they are physically different buildings. A city therefore counts as closed
 * only when EVERY warehouse feeding it is closed — if Noida takes a day and
 * Gurgaon does not, DELHI still moves stock, and marking the city shut would
 * suppress real findings for a warehouse that was open all day.
 */
export function foldCalendar(
  weeklyOffRows: MasterRow[],
  holidayRows: MasterRow[]
): WarehouseCalendar {
  // city -> weekday -> { closed: how many warehouses close, total: how many exist }
  const weekTally = new Map<City, Map<number, { closed: number; total: number }>>();
  for (const r of weeklyOffRows) {
    const city = normalizeCity(r.city);
    const day = WEEKDAY_INDEX[String(r["week day"] ?? "").trim().slice(0, 3).toLowerCase()];
    if (!city || day === undefined) continue;
    const perCity = weekTally.get(city) ?? new Map();
    const cur = perCity.get(day) ?? { closed: 0, total: 0 };
    cur.total++;
    if (r.status === true) cur.closed++;
    perCity.set(day, cur);
    weekTally.set(city, perCity);
  }

  const weeklyOff: Partial<Record<City, number[]>> = {};
  for (const [city, perDay] of weekTally) {
    const days = [...perDay.entries()]
      .filter(([, v]) => v.total > 0 && v.closed === v.total)
      .map(([d]) => d)
      .sort((a, b) => a - b);
    if (days.length > 0) weeklyOff[city] = days;
  }

  const holidayTally = new Map<City, Set<string>>();
  for (const r of holidayRows) {
    if (r.status !== true) continue; // a switched-off holiday row is not a closure
    const iso = parseDmy(r.date);
    if (!iso) continue;
    const cities = Array.isArray(r.city) ? r.city : [r.city];
    for (const raw of cities) {
      const city = normalizeCity(raw);
      if (!city) continue;
      const set = holidayTally.get(city) ?? new Set<string>();
      set.add(iso);
      holidayTally.set(city, set);
    }
  }

  const holidays: Partial<Record<City, string[]>> = {};
  for (const [city, set] of holidayTally) holidays[city] = [...set].sort();

  return { weeklyOff, holidays };
}

/**
 * Read the calendar from the delivery app.
 *
 * Best-effort by contract: every caller treats a null as "no calendar today"
 * and falls back to the hardcoded map. A Mongo hiccup must never stop a
 * reconcile, and a calendar is not worth a failed run.
 */
export async function readWarehouseCalendar(): Promise<WarehouseCalendar | null> {
  const uri = process.env.DT_MONGODB_URI;
  if (!uri) return null;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000 });
  try {
    await client.connect();
    const db = client.db(process.env.DT_MONGODB_DB ?? "cityfurnish");
    const col = db.collection("master_datas");
    const [weekDoc, holidayDoc] = await Promise.all([
      col.findOne({ master: "weekly_off" }),
      col.findOne({ master: "holiday" }),
    ]);
    const rowsOf = (d: unknown): MasterRow[] => {
      const rows = (d as { rows?: unknown } | null)?.rows;
      return Array.isArray(rows) ? (rows as MasterRow[]) : [];
    };
    return foldCalendar(rowsOf(weekDoc), rowsOf(holidayDoc));
  } catch {
    return null;
  } finally {
    await client.close().catch(() => {});
  }
}
