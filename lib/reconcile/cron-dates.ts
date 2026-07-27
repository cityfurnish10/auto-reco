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
//   16:00 IST on D+1  → reconcile D   (its window shut an hour earlier)
//   16:15 IST on D+1  → email     D   (the day just reconciled)
//
// vercel.json holds those as UTC cron strings and CANNOT carry a comment — it
// is strict JSON and Vercel's schema rejects unknown keys, so the mapping is
// recorded here instead:
//
//   "30 10 * * *"  = 10:30 UTC = 16:00 IST   /api/cron/reconcile
//   "45 10 * * *"  = 10:45 UTC = 16:15 IST   /api/cron/email-digest
//
// Vercel Hobby does not guarantee the 15-minute gap between them, which is why
// the digest reports an incomplete run rather than silently falling back to the
// previous day (see app/api/cron/email-digest/route.ts).
//
// Worked example: 25 Jul covers 25 Jul 15:00 → 26 Jul 15:00; it is reconciled
// at 16:00 on the 26th and emailed at 16:15 on the 26th.
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
