// Which business day each daily job targets.
//
// A business day runs 15:00 → 15:00 IST: business date D covers D 15:00 until
// D+1 15:00. That is when the floor actually closes — the guard register is
// ruled off and handed over mid-afternoon — so a day's books are complete
// shortly after 15:00 the following afternoon, not at midnight.
//
// Both jobs therefore close the SAME day, minutes apart, on the afternoon of
// D+1:
//
//   16:30 IST on D+1  → reconcile D   (its window shut 90 minutes earlier)
//   16:45 IST on D+1  → email     D   (the day just reconciled)
//
// vercel.json holds those as UTC cron strings and CANNOT carry a comment — it
// is strict JSON and Vercel's schema rejects unknown keys, so the mapping is
// recorded here instead:
//
//   "0 11 * * *"   = 11:00 UTC = 16:30 IST   /api/cron/reconcile
//   "15 11 * * *"  = 11:15 UTC = 16:45 IST   /api/cron/email-digest
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
// Worked example: 25 Jul covers 25 Jul 15:00 → 26 Jul 15:00; it is reconciled
// at 16:30 on the 26th and emailed at 16:45 on the 26th. Its FOLLOW-UP goes out
// on the 28th, after the reconcile cron's re-check pass has re-run the 25th.
//
// This replaces the old midnight-boundary cadence (22:00 reconcile of D-1,
// 09:00 next-morning digest of D-2), where the two jobs ran on different
// calendar days and so needed different offsets. They no longer do.
//
// Pure and IST-based (never the server's UTC calendar date), so the crons and
// their tests agree on the target regardless of the hour the job fires.

import { addDays } from "../engine/dates";
import { utcToBusinessDate } from "../connectors/ist-window";
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

// Kept as named aliases so call sites read as intent rather than mechanism.
// Both jobs deliberately resolve to the same day now.
export const reconcileTargetDate = lastClosedBusinessDate;
export const digestTargetDate = lastClosedBusinessDate;

// The date the reconcile cron's SECOND pass re-runs, and therefore the date the
// follow-up email reports on the same afternoon.
//
// Two days behind the primary target, not one. D's digest goes out on D+1 and
// the follow-up on D+3, so D must be re-run on D+3 — which is exactly what
// `primary - 2` resolves to on that afternoon. A third pass was the obvious
// alternative and does not fit the 60s ceiling (a pass is p50 36s).
export function recheckTargetDate(now: Date = new Date()): string {
  return addDays(lastClosedBusinessDate(now), -2);
}

// The business date whose follow-up email is due this afternoon. Same day the
// re-check pass just re-ran, by construction — they must never diverge.
export function followupTargetDate(now: Date = new Date()): string {
  return recheckTargetDate(now);
}
