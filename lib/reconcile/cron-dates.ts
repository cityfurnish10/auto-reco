// Which business day each nightly job targets.
//
// A business day's data is NOT complete when that day ends: the ops sheet gets
// filled through the evening, DT scans trickle in, and Odoo postings routinely
// land the NEXT day (measured: ~half). Reconciling a day at 22:00 on the day
// itself therefore judges half-written books. So the cadence is deliberately
// one day behind:
//
//   night of D (22:00 IST)   → reconcile D-1   (a full extra day of entries)
//   morning of D+1 (09:00)   → email  D-1      (the day reconciled last night)
//
// Worked example: 24 Jul is reconciled on the night of the 25th, and its digest
// is emailed on the morning of the 26th. Relative to the moment each job runs
// that is D-1 for the reconcile and D-2 for the digest — the SAME business day,
// which is the whole point.
//
// Pure and IST-based (never the server's UTC calendar date), so both crons and
// their tests agree on the target regardless of the hour the job fires.

import { addDays } from "../engine/dates";
import { utcToIstDate } from "../connectors/ist-window";

// The IST calendar date at a given instant.
export function istDate(now: Date = new Date()): string {
  return utcToIstDate(now)!; // a real Date always parses
}

// The business day the nightly reconcile should close (runs 22:00 IST).
export function reconcileTargetDate(now: Date = new Date()): string {
  return addDays(istDate(now), -1);
}

// The business day the morning digest should report (runs 09:00 IST) — the day
// last night's reconcile closed.
export function digestTargetDate(now: Date = new Date()): string {
  return addDays(istDate(now), -2);
}
