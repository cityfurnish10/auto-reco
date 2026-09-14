// Calendar days (IST) for the gate app and the Gate screens.
//
// Decided 14 Sep 2026: "the guard app should run on calendar dates, rather than
// warehouse dates." A guard, a gate supervisor and a manager reading Activity
// all mean midnight-to-midnight when they say "the 13th". The warehouse day
// (15:00 → 15:00, lib/connectors/ist-window.ts) stays exactly where it is — in
// the RECONCILIATION, which compares against Odoo and the ops sheet on that day,
// and in gate_scans.business_date, which sync still writes for it.
//
// The confusion this ends: "Activity for 13.09.2026" was showing trucks that
// left on the morning of the 14th.

const IST_MS = 5.5 * 3600_000;

/** The IST calendar date an instant falls on. */
export function istDateOf(iso: string | number | Date): string {
  const t = iso instanceof Date ? iso.getTime() : typeof iso === "number" ? iso : Date.parse(iso);
  return new Date(t + IST_MS).toISOString().slice(0, 10);
}

/** Today, IST. */
export const istToday = (now: Date = new Date()): string => istDateOf(now);

/** A calendar date as the UTC instants that bound it: [from, to). */
export function istDayRange(date: string): { from: string; to: string } {
  const start = Date.parse(`${date}T00:00:00+05:30`);
  return { from: new Date(start).toISOString(), to: new Date(start + 86_400_000).toISOString() };
}

export const isIsoDate = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** The calendar date one day before or after. */
export function shiftIstDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
