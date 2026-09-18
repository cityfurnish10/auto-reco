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

// ── The cutover: calendar days from 13 September 2026 ───────────────────────
//
// DECIDED 16 Sep 2026. The 15:00 boundary was doing two jobs at once — saying
// which movements belong to a day, AND waiting for Odoo to catch up. Only the
// second is a real constraint, and it is a timing problem rather than a
// definition of a day.
//
// Three of the four books genuinely run on calendar days: the guard app records
// calendar dates, the sheet is a page per date, and a delivery task is
// scheduled for a date. Only Odoo lags, and it is handled by a matching window
// instead (lib/engine/odoo-window.ts).
//
// What the 15:00 cut cost, measured on Delhi's first live week: the outward
// session runs 09:30-11:30, which the old rule places at the END of the
// PREVIOUS day — so a Monday-morning dispatch was Sunday's problem, its Odoo
// posting landed Tuesday lunchtime, and the day could not be judged until
// Tuesday night. On calendar days the same dispatch is Monday's and is complete
// by Tuesday evening: a full day earlier, for no loss of evidence.
//
// KEYED ON THE DATE, NOT ON "FROM NOW ON". The re-check pass reaches back days,
// and a manager can re-run any date; both must reproduce what a date meant,
// which a "switch it on today" flag cannot do.
// Overridable the same way GATE_APP_CITIES is, and for the same two reasons: a
// change this wide needs to be measurable by running the real connectors BOTH
// ways over the same dates (set it to a far-future date to reproduce the old
// rule exactly), and if the cutover turns out to be wrong it can be moved
// without a deploy. It stays keyed on the DATE either way — this moves where
// the seam falls, never "which rule is on today".
export const CALENDAR_DAYS_FROM = process.env.CALENDAR_DAYS_FROM ?? "2026-09-13";

/** Does this date use the calendar definition, or the old 15:00 one? */
export const usesCalendarDay = (date: string): boolean => date >= CALENDAR_DAYS_FROM;

/**
 * The UTC span a date covers, under whichever definition that date uses.
 *
 * THE SEAM IS TRUNCATED, and this is the part that is easy to get wrong. The
 * last old-style day (12 Sep) nominally runs to 13 Sep 15:00, while the first
 * calendar day (13 Sep) starts at 13 Sep 00:00 — so the morning of the 13th
 * would fall inside BOTH, and every movement in it would be counted, chased and
 * emailed twice. The old day is cut at the boundary instead: nothing belongs to
 * two days, and nothing belongs to none.
 */
export function dayToUtcWindow(date: string): { startUtc: string; endUtcExclusive: string } {
  if (usesCalendarDay(date)) return istDayToUtcWindow(date);
  const win = businessDayToUtcWindow(date);
  const cutover = istDayToUtcWindow(CALENDAR_DAYS_FROM).startUtc;
  return win.endUtcExclusive > cutover
    ? { startUtc: win.startUtc, endUtcExclusive: cutover }
    : win;
}

/**
 * A UTC instant → the date it belongs to, under the definition in force then.
 *
 * Decided by the instant's own CALENDAR date, which is what makes the seam
 * consistent with dayToUtcWindow above: anything on or after 13 Sep is placed
 * on its calendar day, and anything before keeps the 15:00 mapping.
 */
export function utcToDayDate(
  value: string | number | Date | null | undefined
): string | undefined {
  const calendar = utcToIstDate(value);
  if (calendar === undefined) return undefined;
  return usesCalendarDay(calendar) ? calendar : utcToBusinessDate(value);
}

/**
 * The widened span for Odoo's posting lag, under the date's own definition.
 *
 * Not truncated at the seam, unlike dayToUtcWindow: this is a PULL window for a
 * source whose timestamp is a posting time rather than a movement time, so it
 * deliberately reaches either side of the day to catch a posting made late.
 * Attribution is decided afterwards by utcToDayDate, and that is where the
 * seam is enforced.
 */
export function daySpanToUtcWindow(
  date: string,
  daysBefore: number,
  daysAfter: number
): { startUtc: string; endUtcExclusive: string } {
  return usesCalendarDay(date)
    ? istDaySpanToUtcWindow(date, daysBefore, daysAfter)
    : businessDaySpanToUtcWindow(date, daysBefore, daysAfter);
}


// ── Odoo OUT: the 15:00 window, by the owner's process ──────────────────────
//
// Decided 18 Sep 2026. Delhi's team validates a day's dispatches in one batch
// at lunchtime the NEXT day — measured, 59 of the 69 outward postings for the
// 15th landed between 11:00 and 15:00 on the 16th. So Odoo's record of day D's
// outward movements is its Out postings from D 15:00 to D+1 15:00, checked
// against Odoo's own Moves History (Done · Movement Type = Out · Date between)
// and matched to the row.
//
// OUT ONLY. Inward is posted within minutes of the goods arriving (median 0.1
// hours after the gate scan), so it belongs on the calendar day with the other
// three books.
//
// THE 30-SECOND GRACE. A batch submitted at 15:00 is stamped a few seconds
// later: on the 16th, postings landed at 15:00:13 and 15:00:58. A sharp cut
// gives 69 where the owner's Odoo filter showed 70; the whole 15:00 minute
// gives 71. Thirty seconds keeps the posting that was plainly part of the 3pm
// batch and sends the next one to the following day. The same instant ends one
// day and starts the next, so no posting is ever counted twice.
export const ODOO_OUT_DAY_START_MS = (15 * 60 * 60 + 30) * 1000;

/**
 * A posting time → the day whose OUTWARD movements it is Odoo's evidence for.
 *
 * Only for dates on the calendar definition. Before the 13 Sep 2026 cutover the
 * whole engine ran on the 15:00 day, which already treated Odoo this way.
 */
export function utcToOdooOutDate(
  value: string | number | Date | null | undefined,
  /**
   * Was the warehouse open on this date? A closed day has no 3pm handover, so
   * the window runs on to 3pm of the next day the warehouse opens — decided
   * 18 Sep 2026 for Delhi's 16th, with the 17th a Thursday week-off: its Odoo
   * Out runs to 3pm on the 18th. Omitted = every day open.
   */
  isOpen?: (date: string) => boolean
): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  let day = utcToIstDate(new Date(d.getTime() - ODOO_OUT_DAY_START_MS));
  if (day === undefined) return undefined;
  if (!usesCalendarDay(day)) return utcToBusinessDate(value);
  // Step back over closed days to the last day that had movements. Bounded:
  // a week of closures in a row is a calendar fault, not a long weekend, and
  // must not walk a posting back across the cutover.
  for (let i = 0; i < 7 && isOpen && !isOpen(day); i++) {
    const prev = previousDate(day);
    if (!usesCalendarDay(prev)) break;
    day = prev;
  }
  return day;
}

/** "2026-09-17" → "2026-09-16". */
function previousDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - DAY_MS).toISOString().slice(0, 10);
}
