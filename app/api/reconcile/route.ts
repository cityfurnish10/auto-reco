// POST /api/reconcile — ADMIN-triggered manual reconciliation. Runs the exact
// same pipeline as the nightly cron (lib/reconcile/pipeline.ts), but gated by the
// admin's session instead of CRON_SECRET, so the "Run Reconciliation" button can
// call it directly. Defaults to today; accepts an optional { date } / ?date=.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { runReconcilePipeline } from "@/lib/reconcile/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // Hobby ceiling; raise to 300 on Vercel Pro.

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function POST(req: NextRequest) {
  const me = await getCurrentAppUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "forbidden — admin only" }, { status: 403 });
  }
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 500 });
  }

  // date from body or ?date=, else today.
  let bodyDate: string | undefined;
  try {
    bodyDate = (await req.json())?.date;
  } catch {
    /* no body is fine */
  }
  const runDate = (bodyDate || req.nextUrl.searchParams.get("date") || todayISO()).trim();

  const db = createAdminClient();
  const result = await runReconcilePipeline(db, {
    runDate,
    trigger: "manual",
    triggeredBy: me.id,
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
