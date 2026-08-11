// Settle the part of the variance queue nobody will ever work — the daily
// entry point for lib/reconcile/settle.ts.
//
// A THIRD VERCEL CRON IS NOT AVAILABLE (Hobby caps at two, both used by
// reconcile and the digest), so this is scheduled from Postgres alongside the
// re-check sweep — see supabase/migrations/0021_variance_noise.sql. It is a
// single bounded UPDATE pass with no connector traffic, so it is nowhere near
// the 60s ceiling that shapes the reconcile route.
//
// Excluded from middleware auth via the `api/cron` matcher exclusion; enforces
// its own bearer-token check, byte-for-byte the same as /api/cron/reconcile.
//
// GET is a DRY RUN and POST commits. That asymmetry is deliberate: this is the
// one scheduled job that closes rows in bulk, and a mistyped URL in a browser
// must not be able to settle thirteen thousand of them. `?dryRun=1` forces the
// preview on either verb.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DISABLED_BODY, cronAuthorized, scheduledJobsDisabled } from "@/lib/reconcile/cron-guard";
import { lastClosedBusinessDate } from "@/lib/reconcile/cron-dates";
import { settleUnactionableVariances } from "@/lib/reconcile/settle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest, commit: boolean) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Authorised FIRST, so an unauthenticated caller never learns which
  // deployment owns the schedule.
  if (scheduledJobsDisabled()) return NextResponse.json(DISABLED_BODY);
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json(
      { error: "Supabase not configured (need URL + SERVICE_ROLE key)." },
      { status: 500 }
    );
  }

  const forcedDryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const dryRun = forcedDryRun || !commit;

  try {
    const result = await settleUnactionableVariances(createAdminClient(), {
      today: lastClosedBusinessDate(),
      dryRun,
    });
    return NextResponse.json({ ok: true, dryRun, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req, false);
}

export async function POST(req: NextRequest) {
  return handle(req, true);
}
