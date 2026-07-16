// GET /api/system-health — the activity/health feed for the System Health page.
// Admin-only (analytics/system-health are admin-gated in middleware + sidebar).
// Returns recent reconciliation runs, source-ingestion logs, guard uploads, and
// digest email sends, plus a per-source "last sync" health summary. The page
// merges these into one chronological timeline.

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT = 25;
const SOURCES = ["ODOO", "SHEET", "DT", "PHYSICAL"] as const;

export async function GET() {
  const me = await getCurrentAppUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const db = createAdminClient();

  const [runsR, ingR, upR] = await Promise.all([
    db
      .from("reconciliation_runs")
      .select("id,business_date,created_at,completed_at,status,trigger,triggered_by,total,real_count,info_count")
      .order("created_at", { ascending: false })
      .limit(LIMIT),
    db
      .from("ingestion_logs")
      .select("id,run_id,source,status,rows_pulled,message,started_at,finished_at,duration_ms,created_at")
      .order("created_at", { ascending: false })
      .limit(80),
    db
      .from("guard_uploads")
      .select("id,created_at,city,file_name,status,rows_parsed,error")
      .order("created_at", { ascending: false })
      .limit(LIMIT),
  ]);
  const err = runsR.error || ingR.error || upR.error;
  if (err) return NextResponse.json({ error: err.message }, { status: 500 });

  // email_logs may not exist yet (migration 0007) — treat as empty on error so
  // the page still renders before the migration is applied.
  let emails: unknown[] = [];
  const emR = await db
    .from("email_logs")
    .select("id,created_at,kind,status,recipients,business_date,error,message_id")
    .order("created_at", { ascending: false })
    .limit(LIMIT);
  if (!emR.error) emails = emR.data ?? [];

  // Source health = latest ingestion row per source (ingR is newest-first).
  const latest = new Map<string, (typeof ingR.data)[number]>();
  for (const row of ingR.data ?? []) if (!latest.has(row.source)) latest.set(row.source, row);
  const sourceHealth = SOURCES.map((s) => {
    const r = latest.get(s);
    return {
      source: s,
      status: r ? r.status : "UNKNOWN",
      lastAt: r ? r.finished_at ?? r.created_at : null,
      rows: r ? r.rows_pulled : null,
      message: r?.message ?? null,
      durationMs: r?.duration_ms ?? null,
    };
  });

  return NextResponse.json({
    runs: runsR.data ?? [],
    ingestion: ingR.data ?? [],
    uploads: upR.data ?? [],
    emails,
    sourceHealth,
  });
}
