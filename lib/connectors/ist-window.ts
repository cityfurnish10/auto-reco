// IST day → UTC datetime windows. Two day definitions live here, and which one
// a caller wants depends on whether its source carries a real event time:
//
//   CALENDAR day (midnight → midnight)  — istDayToUtcWindow / utcToIstDate
//   BUSINESS day (15:00 → 15:00 IST)    — businessDay* / utcToBusinessDate
//
// Both Odoo and DT store timestamps in UTC, so every date filter must convert.
// For the calendar day:
//   date 00:00:00 IST    →  date-1 18:30:00 UTC   (inclusive start)
//   date+1 00:00:00 IST  →  date   18:30:00 UTC   (exclusive end)

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function istDayToUtcWindow(runDate: string): {
  startUtc: string;
  endUtcExclusive: string;
} {
  const [y, m, d] = runDate.split("-").map(Number);
  const startMs = Date.UTC(y, m - 1, d) - IST_OFFSET_MS;
  const endMs = startMs + DAY_MS;
  return {
    startUtc: new Date(startMs).toISOString(),
    endUtcExclusive: new Date(endMs).toISOString(),
  };
}

// Widened variant: [runDate - daysBefore, runDate + daysAfter] as one UTC span.
// Used by the Odoo connector to capture posting lag (measured on real data,
// 2026-07-12: 302 of 607 DT movements were posted in Odoo the NEXT day —
// sml.date is the posting timestamp, set at validation, not the physical
// movement date).
export function istDaySpanToUtcWindow(
  runDate: string,
  daysBefore: number,
  daysAfter: number
): { startUtc: string; endUtcExclusive: string } {
  const [y, m, d] = runDate.split("-").map(Number);
  const startMs = Date.UTC(y, m - 1, d) - IST_OFFSET_MS - daysBefore * DAY_MS;
  const endMs = Date.UTC(y, m - 1, d) - IST_OFFSET_MS + (daysAfter + 1) * DAY_MS;
  return {
    startUtc: new Date(startMs).toISOString(),
    endUtcExclusive: new Date(endMs).toISOString(),
  };
}

// UTC instant → the IST calendar date ("YYYY-MM-DD") it falls on.
//
// This is the CALENDAR-day mapping and stays midnight-based on purpose. It is
// still the right answer for things that really are calendar days — bucketing
// email_logs for the 30-day archive view, for instance. For "which business day
// did this movement belong to", use utcToBusinessDate below.
export function utcToIstDate(value: string | number | Date | null | undefined): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// ── Business day: 15:00 → 15:00 IST ─────────────────────────────────────────
//
// A warehouse day does not end at midnight. The guard register is ruled off and
// handed over mid-afternoon, so business date D covers D 15:00 IST → D+1 15:00
// IST. The nightly jobs run just after that boundary (16:00 reconcile, 16:15
// digest), closing D on the afternoon of D+1.
//
// This applies ONLY to sources carrying a real event timestamp:
//   • ODOO   — sml.date is stamped at validation. Windowed.
//   • DT     — measured 2026-07: 6,659 of 6,753 scheduledDate values sit at
//              exactly 10:00 IST. It is a date marker pinned to a fixed hour,
//              not an event time, so a 15:00 split would move EVERY DT row back
//              a day. DT stays on the calendar-day window above.
//   • SHEET / PHYSICAL — hand-typed dates with no time at all. Matched by date.
export const BUSINESS_DAY_START_HOUR = 15;
const BUSINESS_DAY_OFFSET_MS = BUSINESS_DAY_START_HOUR * 60 * 60 * 1000;

// Business date → the UTC span it covers. D 15:00 IST is D 09:30 UTC.
export function businessDayToUtcWindow(businessDate: string): {
  startUtc: string;
  endUtcExclusive: string;
} {
  const [y, m, d] = businessDate.split("-").map(Number);
  const startMs = Date.UTC(y, m - 1, d) - IST_OFFSET_MS + BUSINESS_DAY_OFFSET_MS;
  return {
    startUtc: new Date(startMs).toISOString(),
    endUtcExclusive: new Date(startMs + DAY_MS).toISOString(),
  };
}

// Widened variant for Odoo's posting lag — [D - daysBefore, D + daysAfter] of
// whole business days, as one UTC span.
export function businessDaySpanToUtcWindow(
  businessDate: string,
  daysBefore: number,
  daysAfter: number
): { startUtc: string; endUtcExclusive: string } {
  const [y, m, d] = businessDate.split("-").map(Number);
  const anchorMs = Date.UTC(y, m - 1, d) - IST_OFFSET_MS + BUSINESS_DAY_OFFSET_MS;
  return {
    startUtc: new Date(anchorMs - daysBefore * DAY_MS).toISOString(),
    endUtcExclusive: new Date(anchorMs + (daysAfter + 1) * DAY_MS).toISOString(),
  };
}

// UTC instant → the BUSINESS date it belongs to. Shifting back 15 h turns the
// 15:00 boundary into a midnight one, so the calendar mapping then applies.
//
// This is the counterpart to the window functions and must move with them: the
// engine decides REAL vs INFO by comparing an Odoo posting's date to the run
// date (lib/engine/run.ts), so windowing the pull without re-basing attribution
// would silently reclassify every posting made between 15:00 and midnight.
export function utcToBusinessDate(
  value: string | number | Date | null | undefined
): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return utcToIstDate(new Date(d.getTime() - BUSINESS_DAY_OFFSET_MS));
}
