// Attach unit details to gate scans that do not have them yet.
//
// WHY THIS IS A JOB AND NOT PART OF THE SYNC. The phone's sync is the one path
// that must never be slow: a guard is standing at a gate with a truck in front
// of them, and applyBatch already does real work under a 60s serverless
// ceiling. Adding a Metabase round trip to it would put an external system on
// the critical path of recording a movement — so a Metabase outage would slow,
// and eventually fail, the thing the gate exists to do.
//
// Enrichment has none of that urgency. A scan without it is already a complete
// record of a unit crossing a gate; the details only decide how much context a
// manager sees when they chase it. So it runs after the fact, and its failure
// costs nothing.
//
// Scheduled from Postgres (migration 0038) rather than Vercel: Hobby caps the
// project at two crons and both are taken. Same shape as gate-expected and
// gate-media.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { jsonRoute } from "@/lib/api/json-route";
import { DISABLED_BODY, cronAuthorized, scheduledJobsDisabled } from "@/lib/reconcile/cron-guard";
import { enrichScans, isMissingColumn } from "@/lib/gate/enrich-run";
import { metabaseConfigured } from "@/lib/connectors/metabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** One batch. Enough to clear a normal day in a single run without asking Odoo
 *  for thousands of serials at once. Whatever is left is picked up next run. */
const LIMIT = 500;

export const POST = jsonRoute("cron/gate-enrich", async (req: NextRequest) => {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (scheduledJobsDisabled()) return NextResponse.json(DISABLED_BODY);

  if (!metabaseConfigured()) {
    // Not an error. Without Metabase there is nothing to look a serial up in,
    // and the scans remain perfectly valid records.
    return NextResponse.json({ ok: true, skipped: "metabase not configured" });
  }

  const db = createAdminClient();

  // Two passes wanted: Odoo (enriched_at, 0037) and DT (task_checked_at, 0039).
  // Asked for together, falling back to the Odoo pass alone if 0039 has not
  // been applied — migrations go in by hand, and a missing column must cost the
  // new lookup, not the one that already worked.
  const base = () => db.from("gate_scans").select("id,barcode,scanned_at,direction,enriched_at,task_checked_at")
    .eq("status", "recorded").not("barcode", "is", null);
  let dtReady = true;
  let res = await base().or("enriched_at.is.null,task_checked_at.is.null")
    .order("scanned_at", { ascending: false }).limit(LIMIT);
  if (isMissingColumn(res.error)) {
    dtReady = false;
    res = await db.from("gate_scans").select("id,barcode,scanned_at,direction,enriched_at")
      .eq("status", "recorded").not("barcode", "is", null).is("enriched_at", null)
      .order("scanned_at", { ascending: false }).limit(LIMIT) as typeof res;
  }
  if (res.error) throw new Error(`gate-enrich: reading scans failed: ${res.error.message}`);

  const rows = (res.data ?? []) as { id: string; barcode: string; scanned_at: string; direction: string | null; enriched_at: string | null; task_checked_at?: string | null }[];
  if (rows.length === 0) return NextResponse.json({ ok: true, considered: 0, dtReady });

  const outcome = await enrichScans(db, rows.map((r) => ({
    id: r.id, barcode: r.barcode, scannedAt: r.scanned_at, direction: r.direction,
    needsFacts: !r.enriched_at,
    needsTask: dtReady && !r.task_checked_at,
  })));

  return NextResponse.json({ ok: outcome.failed.length === 0, dtReady, ...outcome });
});
