// The two checks every /api/cron/* route runs before it does anything.
//
// WHY THIS FILE EXISTS. The bearer check below was copied byte-for-byte into
// four routes — reconcile, settle, ocr, email-digest — and each copy carried a
// comment saying it was identical to the others. That was survivable while
// there was one thing to check. It stopped being survivable the moment a SECOND
// deployment of this app appeared: a flag that must hold for every scheduled
// entry point cannot live in four places, because the failure mode of missing
// one is silent and only shows up as a duplicate email or a corrupted day.

import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

/**
 * Constant-time bearer check — avoids leaking the secret via response-timing.
 *
 * Vercel Cron injects `Authorization: Bearer $CRON_SECRET` from the project's
 * OWN environment, and the pg_cron sweeps read theirs from Supabase Vault
 * (`app_cron.secret()`, migration 0018). All three must carry the same value.
 */
export function cronAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Is this deployment allowed to run scheduled work at all?
 *
 * EXACTLY ONE DEPLOYMENT MAY OWN THE SCHEDULE, and this is how a second one is
 * told it does not. The app is now published from two repositories and hosted
 * twice against ONE Supabase project; `vercel.json` declares the crons, so a
 * second Vercel project inherits both of them automatically.
 *
 * Three things break when two deployments run the pipeline on one database, in
 * descending severity:
 *
 *   1. saveSourceRows RACES AND CAN LOSE A WHOLE DAY'S RAW FEED. It inserts its
 *      pull, then deletes rows for that (business_date, source) belonging to
 *      other runs. Interleaved: A inserts, B inserts, A deletes not-A (B gone),
 *      B deletes not-B (A gone) -- nothing left. This is the reason the flag is
 *      mandatory rather than tidy.
 *   2. Two digest emails a night, to the real recipient list.
 *   3. Every date reconciled twice, doubling load on Odoo / DT / Sheets -- the
 *      same overload that previously produced "ODOO source failed: terminated"
 *      and a DT socket timeout.
 *
 * Set SCHEDULED_JOBS_DISABLED=1 on the deployment that must stay quiet. Its
 * dashboards, API and manual actions all keep working; only the scheduled
 * entry points decline.
 *
 * Chosen over deleting the `crons` block from vercel.json, which would fork a
 * tracked file between the two repositories forever; and over relying on a
 * CRON_SECRET mismatch, which does not work at all -- Vercel injects each
 * project's own secret, so the routes would authenticate perfectly.
 */
export function scheduledJobsDisabled(): boolean {
  return process.env.SCHEDULED_JOBS_DISABLED === "1";
}

/**
 * What a disabled route returns.
 *
 * 200, NOT an error. A deployment declining work it was told not to do has not
 * failed, and the callers cannot tell the difference anyway: Vercel Cron
 * discards the response body, and pg_net records its own dispatch as succeeded
 * whatever the HTTP status (see the note in migration 0018). Returning 500
 * would only make a healthy configuration look broken in the one history that
 * does survive.
 */
export const DISABLED_BODY = {
  ok: true as const,
  skipped: "scheduled jobs disabled on this deployment" as const,
};
