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
import { fetchUnitFacts } from "@/lib/gate/enrich";
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
  const { data, error } = await db
    .from("gate_scans")
    .select("id,barcode")
    .is("enriched_at", null)
    .eq("status", "recorded")
    .not("barcode", "is", null)
    .order("scanned_at", { ascending: false })
    .limit(LIMIT);
  if (error) throw new Error(`gate-enrich: reading scans failed: ${error.message}`);

  const scans = (data ?? []) as { id: string; barcode: string }[];
  if (scans.length === 0) return NextResponse.json({ ok: true, considered: 0 });

  const facts = await fetchUnitFacts(scans.map((s) => s.barcode));

  const now = new Date().toISOString();
  let matched = 0;
  for (const s of scans) {
    const f = facts.get(s.barcode.trim());
    // enriched_at is stamped either way. A serial Odoo has never heard of is an
    // answer, and re-asking every run would spend the whole budget on the same
    // unknown units forever.
    const patch = f
      ? {
          unit_product: f.product, unit_sku: f.sku,
          last_customer: f.lastCustomer, last_so: f.lastSo,
          last_direction: f.lastDirection, last_moved_at: f.lastMovedAt,
          enriched_at: now,
        }
      : { enriched_at: now };
    const { error: upErr } = await db.from("gate_scans").update(patch).eq("id", s.id);
    // One row failing must not abandon the rest; it is simply picked up next run.
    if (!upErr && f) matched++;
  }

  return NextResponse.json({
    ok: true,
    considered: scans.length,
    matched,
    unknownToOdoo: scans.length - matched,
  });
});
