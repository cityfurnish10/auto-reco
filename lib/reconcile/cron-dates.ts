// Which business day each daily job targets.
//
// A business day runs 15:00 → 15:00 IST: business date D covers D 15:00 until
// D+1 15:00. That is when the floor actually closes — the guard register is
// ruled off and handed over mid-afternoon — so a day's books are complete
// shortly after 15:00 the following afternoon, not at midnight.
//
// FROM 13 SEP 2026 (calendar days): 17:00 IST on D+1 reconciles D, and 18:00
// emails it — see reconcileTargetDate. What follows is the older 15:00-day
// cadence, still what a pre-cutover date gets on re-run.
//
// Both jobs close the SAME day, minutes apart — but not the day that just shut.
// REPORTING_LAG_DAYS (below) holds a day back so late Odoo postings land first,
// so with the lag at 1 the cadence was:
//
//   20:00 IST on D+2  → reconcile D   (its window shut 29 hours earlier —
//                        the 20:00 hour was moved from 16:30 on 2026-08-01:
//                        only 8 of 38 guard registers had ever arrived by
//                        16:30, 15 by 20:00)
//   21:00 IST on D+2  → email     D   (the day just reconciled)
//
// Read the offsets from REPORTING_LAG_DAYS, never from this comment: every
// target below is derived from it, and it is the one number to change.
//
// vercel.json holds those as UTC cron strings and CANNOT carry a comment — it
// is strict JSON and Vercel's schema rejects unknown keys, so the mapping is
// recorded here instead:
//
//   "30 11 * * *"  = 11:30 UTC = 17:00 IST   /api/cron/reconcile
//   "30 12 * * *"  = 12:30 UTC = 18:00 IST   /api/cron/email-digest
//
// MOVED 18 Sep 2026 from 20:00 / 21:00 (owner's decision). The ops sheet is
// complete by 16:00 without fail and Odoo's window shuts at 15:00, so by 17:00
// all four books hold the previous calendar day. The email is an hour behind,
// not thirty minutes, because Hobby only promises a cron somewhere inside its
// hour. Known costs, accepted: paper-register cities whose register lands
// after 17:00 read "guard missing" until the re-check pass two days on, and a
// day before a week-off is judged while Odoo's window is still open (those
// rows carry the ODOO PENDING flag — lib/variances/flags.ts).
//
// A THIRD schedule is not available: Vercel Hobby caps at two crons and both
// are used. Everything else rides one of these two — the scheduled-email queue
// is drained by the digest cron, and the re-check pass rides the reconcile
// cron. See lib/email/scheduled.ts for the precedent.
//
// Vercel Hobby does not guarantee the 15-minute gap between them, which is why
// the digest reports an incomplete run rather than silently falling back to the
// previous day (see app/api/cron/email-digest/route.ts).
//
// Worked example at REPORTING_LAG_DAYS = 1: 25 Jul covers 25 Jul 15:00 → 26 Jul
// 15:00. It is reconciled at 20:00 on the 27th and emailed at 21:00 the same
// afternoon. Its FOLLOW-UP goes out on the 29th, after the reconcile cron's
// re-check pass has re-run the 25th — FOLLOW_UP_DELAY_DAYS derives from this
// lag so the two cannot drift apart.
//
// This replaces the old midnight-boundary cadence (22:00 reconcile of D-1,
// 09:00 next-morning digest of D-2), where the two jobs ran on different
// calendar days and so needed different offsets. They no longer do.
//
// Pure and IST-based (never the server's UTC calendar date), so the crons and
// their tests agree on the target regardless of the hour the job fires.

import { addDays } from "../engine/dates";
import { isCityOff } from "../engine/schedule";
import { CITIES } from "../sample-data";
import { utcToBusinessDate, usesCalendarDay } from "../connectors/ist-window";
import { utcToIstDate } from "../connectors/ist-window";

// The IST calendar date at a given instant. Still calendar-based — used for
// "today" in pickers and upper bounds, not for targeting a run.
export function istDate(now: Date = new Date()): string {
  return utcToIstDate(now)!; // a real Date always parses
}

// The business day currently OPEN — the one this instant falls inside.
// Before 15:00 IST that is still yesterday's date.
export function currentBusinessDate(now: Date = new Date()): string {
  return utcToBusinessDate(now)!;
}

// The most recent business day whose 15:00 window has SHUT. This is what both
// daily jobs target, and the only date either of them should ever close.
export function lastClosedBusinessDate(now: Date = new Date()): string {
  return addDays(currentBusinessDate(now), -1);
}

/**
 * How many CLOSED business days to let a day settle before judging it.
 *
 * 0 would mean "reconcile a day the moment its window shuts", which is what
 * this did until 2026-08-11. The owner's instruction — do not fetch the last
 * day's data until the following evening, keep reporting the older day until
 * then — is this constant set to 1.
 *
 * WHY, measured. A movement is written by the floor as it happens and posted in
 * Odoo afterwards, and the gap is routinely more than one night:
 *
 *   * Delhi 2026-08-09, FUE2ME22101158 (SO ON-RET-GUR-74393, repair): the
 *     delivery app recorded it, the reconcile ran at 20:00 on the 10th, and
 *     Odoo had nothing — so it was filed as "DT Only — No Floor or Odoo
 *     Record", a REAL chase item for a movement Odoo does hold.
 *   * Bangalore 6 Aug: of 162 "PO Inward" sheet rows, ALL 162 had an Odoo
 *     receipt — 157 posted +2 days, 5 posted +3.
 *
 * An extra day of settling is the cheapest fix available and costs only
 * freshness: the digest reports the day before yesterday instead of yesterday.
 *
 * WHAT IT DOES NOT FIX, and this matters. The Odoo PULL window is ±1 day around
 * the business date (lib/engine/odoo-window.ts) and running later does not widen
 * it, so a posting made +2 days on is still absent from the day's presence
 * flags. What catches those is the separate recent-postings history
 * (loadRecentOdooPostings, ODOO_HISTORY_DAYS = 3), which demotes the row to
 * "Odoo Entry Made Late". This constant reduces how often that demotion is even
 * needed; it does not replace it.
 *
 * The rest of the cadence is DERIVED from the primary target below, so changing
 * this number moves the whole chain together and the re-check / follow-up
 * invariant holds without being restated.
 */
export const REPORTING_LAG_DAYS = 1;

// The day the nightly jobs close. Both deliberately resolve to the same date.
//
// Named functions rather than aliases of lastClosedBusinessDate, because they
// are no longer the same thing: that is "the most recent day whose window has
// shut", this is "the most recent day we are willing to judge".
export function reconcileTargetDate(now: Date = new Date()): string {
  // CALENDAR DAYS NEED NO LAG, and that is the point of the change rather than
  // a side effect of it. The lag existed because the 15:00 day did not END
  // until 15:00 the following afternoon: its last outward movements crossed the
  // gate that morning, Odoo posted them around midday the day after THAT, and
  // judging the day any sooner meant judging it without a quarter of Odoo.
  //
  // A calendar day is finished at midnight. Its outward postings land about 26
  // hours later — measured at Delhi, leaves 09:29, posted 13:06 the next day —
  // so by the 20:00 run on D+1 Odoo is in. Yesterday, reported tonight: a full
  // day earlier than the old cadence, with more of Odoo present, not less.
  const yesterday = addDays(istDate(now), -1);
  if (usesCalendarDay(yesterday)) return yesterday;
  return addDays(lastClosedBusinessDate(now), -REPORTING_LAG_DAYS);
}
export function digestTargetDate(now: Date = new Date()): string {
  return reconcileTargetDate(now);
}

// The date the reconcile cron's SECOND pass re-runs, and therefore the date the
// follow-up email reports on the same afternoon.
//
// Two days behind the PRIMARY TARGET, not two behind the last closed day. The
// follow-up email for a date must go out on the afternoon that date is re-run,
// and it is scheduled as a fixed delay after that date's digest — so the
// relationship that has to hold is `recheck = primary - FOLLOWUP_DELAY_DAYS`.
// Expressing it against the primary keeps it true when REPORTING_LAG_DAYS
// changes; against lastClosedBusinessDate it would silently drift by exactly
// the lag, and the follow-up would report a date nothing had re-run.
//
// A third pass was the obvious alternative and does not fit the 60s ceiling
// (a pass is p50 36s).
export function recheckTargetDate(now: Date = new Date()): string {
  const primary = reconcileTargetDate(now);
  // A WEEK-OFF PUSHES A DAY'S BOOKS FORWARD, so the re-check has to follow.
  //
  // Owner, 25 Sep 2026: "on Thursdays warehouses are non-operational, so their
  // next day data update across sources happens on Friday, for Wednesday."
  // Wednesday is first judged on Thursday at 17:00 — while the closed cities'
  // ops sheets for it do not exist yet — and the ordinary re-check two days
  // back would not return to it until Saturday. When the primary target is a
  // day those warehouses were shut, the second pass re-runs the day BEFORE it
  // instead: Friday's run re-judges Wednesday, the afternoon its books arrive.
  //
  // Read from the literal week-off map rather than the synced calendar because
  // this file is pure and runs before anything is fetched; the map and the
  // calendar agree on the weekly rule (see lib/engine/schedule.ts).
  const closedForSome = CITIES.some((c) => isCityOff(c, primary));
  return addDays(primary, closedForSome ? -1 : -2);
}

// The business date whose follow-up email is due this afternoon. Same day the
// re-check pass just re-ran, by construction — they must never diverge.
export function followupTargetDate(now: Date = new Date()): string {
  return recheckTargetDate(now);
}

/**
 * How settled is a date somebody is about to reconcile by hand?
 *
 *   "open"  its window has not shut yet — the day is still being worked.
 *   "fresh" it shut this afternoon; the sources have not finished filing.
 *   null    old enough to judge (what the scheduled run targets).
 *
 * Asked for 15 Sep 2026, after a mid-day run of an open date produced two
 * variances for Delhi and read as a clean day. It was not: the day had 2½ hours
 * to go, and the ops sheet had filed nothing at all.
 */
export function runDateFreshness(runDate: string, now: Date = new Date()): "open" | "fresh" | null {
  if (runDate >= currentBusinessDate(now)) return "open";
  if (runDate === lastClosedBusinessDate(now)) return "fresh";
  return null;
}
