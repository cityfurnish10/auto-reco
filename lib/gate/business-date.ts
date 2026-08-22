// The business date a gate event belongs to.
//
// WHY THIS IS A SERVER FUNCTION AND NOT A PHONE ONE. The business day runs
// 15:00 -> 15:00 IST, so the calendar date is wrong for a third of every day: a
// scan at 10:00 on the 21st belongs to business date the 20th. Worse, the phone
// is the guard's own — its clock drifts and its timezone is whatever it is —
// and a mis-dated row does not fail loudly, it silently reconciles against the
// wrong day.
//
// So the DEVICE sends an instant and the SERVER decides the day, reusing the
// same function the reconcile pipeline uses. The two cannot drift apart.
//
// And because the instant is what gets stored, a change to the day boundary —
// which operations has already said is coming — is a single recompute over
// scanned_at, not lost data.

import { utcToBusinessDate } from "../connectors/ist-window";

export interface DatedEvent {
  /** ISO instant from the device. */
  at: string;
  /** When the server received it — the sanity check, not the source. */
  receivedAt?: string;
}

/**
 * How far a device clock may be wrong before the event is suspect.
 *
 * Six hours is deliberately loose. The purpose is not to catch small drift —
 * that is harmless here, since the boundary is only crossed once a day — but to
 * catch a phone whose date is flatly wrong (a factory-reset device, a manual
 * clock change), which would file a whole shift against the wrong day.
 */
export const CLOCK_SKEW_LIMIT_MS = 6 * 60 * 60 * 1000;

export interface ResolvedDate {
  businessDate: string;
  /** Milliseconds the device clock is ahead (+) or behind (-) the server. */
  skewMs: number;
  /** True when the skew exceeds the limit — stored, never rejected. */
  suspectClock: boolean;
}

/**
 * Resolve the business date for a device-timestamped event.
 *
 * A suspect clock is REPORTED, NOT REJECTED. Refusing the row would lose a real
 * movement over a phone setting, and the guard has no way to fix it at the
 * gate. It is recorded, flagged for the manager, and the reconcile still sees
 * the movement.
 */
export function resolveBusinessDate(
  deviceIso: string,
  now: Date = new Date()
): ResolvedDate | null {
  const t = Date.parse(deviceIso);
  if (Number.isNaN(t)) return null;
  const businessDate = utcToBusinessDate(new Date(t));
  if (!businessDate) return null;
  const skewMs = t - now.getTime();
  return {
    businessDate,
    skewMs,
    suspectClock: Math.abs(skewMs) > CLOCK_SKEW_LIMIT_MS,
  };
}
