// Refresh the day's expected pickings, so the gate app can validate a scan
// offline instead of asking Odoo per item.
//
// Scheduled from Postgres rather than Vercel: the two Vercel cron slots are
// taken by the reconcile and the digest, and Hobby allows no more — which is
// why 0018 and 0021 already moved scheduled work into the database.
//
// It refreshes TODAY and TOMORROW. A shift starting at 09:00 needs the list
// before anyone thinks to fetch it, and a dispatch planned late in the evening
// belongs to the next business day.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DISABLED_BODY, cronAuthorized, scheduledJobsDisabled } from "@/lib/reconcile/cron-guard";
import { refreshExpected } from "@/lib/gate/expected";
import { currentBusinessDate } from "@/lib/reconcile/cron-dates";
import { addDays } from "@/lib/engine/dates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (scheduledJobsDisabled()) return NextResponse.json(DISABLED_BODY);

  const db = createAdminClient();
  const today = currentBusinessDate();
  const days = [today, addDays(today, 1)];
  const results: Record<string, unknown>[] = [];

  for (const d of days) {
    try {
      const r = await refreshExpected(db, d);
      results.push({ date: d, ...r });
    } catch (e) {
      // One bad day must not stop the other. A failure here costs the gate
      // check for that date, not the ability to scan.
      results.push({ date: d, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return NextResponse.json({ ok: true, results });
}

export async function GET(req: NextRequest) { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }
