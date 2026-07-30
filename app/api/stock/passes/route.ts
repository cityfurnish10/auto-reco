// GET /api/stock/passes?date=YYYY-MM-DD
//
// Which reconciliation runs exist for a business date, which pair to open on, and
// — when there is only one — why there is no second.
//
// Admin-only, the /api/analytics pattern: getCurrentAppUser() + role check, then
// the service-role client. Never 404s for a date with no runs; the page needs a
// 200 it can explain.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { readRuns, readSnapshots } from "@/lib/stock/db";
import { defaultPair, toPasses } from "@/lib/stock/passes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const me = await getCurrentAppUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const date = (req.nextUrl.searchParams.get("date") ?? "").trim();
  if (!DATE_RE.test(date)) {
    return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }

  const db = createAdminClient();
  let runs, snaps;
  try {
    [runs, snaps] = await Promise.all([readRuns(db, date), readSnapshots(db, date)]);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }

  const { passes, excluded } = toPasses(runs);
  const withSnapshot = new Set((snaps ?? []).map((s) => s.run_id));
  for (const p of passes) p.hasSnapshot = withSnapshot.has(p.runId);

  const pair = defaultPair(passes);

  // Why there is only one pass, when we can say. The budget skip used to exist
  // only in the cron's response body; migration 0017 persists it, which turns
  // "nothing here" into an explanation.
  const skipReason = runs.find((r) => r.recheck_skipped_reason)?.recheck_skipped_reason ?? null;
  const usable = passes.filter((p) => !p.preClose);
  const state = passes.length === 0 ? "no-runs" : usable.length < 2 ? "single-pass" : "ok";

  return NextResponse.json({
    date,
    state,
    passes,
    excluded,
    defaultPair: pair ? { a: pair.a.runId, b: pair.b.runId } : null,
    singlePassReason:
      state === "single-pass" ? (skipReason ? "recheck-skipped" : "no-recheck-recorded") : null,
    singlePassDetail: state === "single-pass" ? skipReason : null,
    // "none" is not the same as "all four were down". The page must say which.
    coverageSource: snaps === null ? "none" : withSnapshot.size > 0 ? "per-run" : "none",
  });
}
