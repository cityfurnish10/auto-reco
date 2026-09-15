// POST /api/gate/unit-details — the customer, order and ticket the gate looked
// up for a set of scanned units.
//
// WHY THIS IS A SEPARATE ROUTE AND NOT A CONNECTOR CHANGE. The obvious fix for
// "the in-transit list has no customer" is to let the reconciliation read the
// gate's looked-up columns. It was tried on 15 Sep 2026 and is wrong: those
// columns are ANSWERS FROM ODOO AND DT (lib/gate/enrich-run.ts). Feeding them
// back as the gate's own evidence would make the fourth witness agree with
// Odoo by construction, which is the one property the gate exists to have.
// tests/gate/enrich.test.ts guards exactly that and caught it.
//
// So the details stay out of the engine and are fetched HERE, for display
// only, by a screen that already has the variance rows. Measured that day:
// customer set on 15 of 380 Delhi scans in the columns the engine reads, and on
// 360 of 380 in the looked-up ones — which is why Activity showed a customer
// and the dashboard did not.
//
// Delhi is the only city this affects, because it is the only city whose floor
// record comes from the app rather than the ops sheet.

import { NextResponse, type NextRequest } from "next/server";
import { jsonRoute } from "@/lib/api/json-route";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { canonicalize } from "@/lib/engine/barcode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface UnitDetail {
  customer: string | null;
  soNumber: string | null;
  ticketId: string | null;
  product: string | null;
  /**
   * The lookup settled on this movement's own task, not a last-known one
   * (migration 0040). False means "this is where the unit was last seen", which
   * a screen must say rather than present as today's customer.
   */
  matched: boolean;
}

const MAX = 500;

export const POST = jsonRoute("gate/unit-details", async (req: NextRequest) => {
  const me = await getCurrentAppUser();
  if (!me || (me.role !== "admin" && me.role !== "manager")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    barcodes?: string[]; date?: string; city?: string; direction?: string;
  };
  const barcodes = (body.barcodes ?? []).filter((b) => typeof b === "string" && b.trim()).slice(0, MAX);
  if (barcodes.length === 0) return NextResponse.json({ details: {} });

  const db = createAdminClient();
  let q = db
    .from("gate_scans")
    .select("barcode, direction, scanned_at, task_customer, task_so, task_ticket, task_matched, unit_product")
    .eq("status", "recorded")
    .in("barcode", barcodes)
    .order("scanned_at", { ascending: false })
    .limit(MAX * 2);
  // A manager is pinned to their own city whatever they ask for.
  const city = me.role === "manager" ? me.city : body.city;
  if (city && city !== "ALL") q = q.eq("city", city);
  if (body.date) q = q.eq("business_date", body.date);
  if (body.direction === "IN" || body.direction === "OUT") q = q.eq("direction", body.direction);

  const res = await q;
  // 0039/0040 are applied by hand. Without them there is simply nothing to
  // show, which is the state the screen was already in.
  if (res.error?.code === "42703") return NextResponse.json({ details: {} });
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });

  // Keyed by the CANONICAL barcode, because a variance row carries the folded
  // spelling and the gate carries the raw one — they differ on exactly the
  // rows an OCR fold was needed for.
  const details: Record<string, UnitDetail> = {};
  for (const r of (res.data ?? []) as Record<string, unknown>[]) {
    const raw = String(r.barcode ?? "").trim();
    if (!raw) continue;
    for (const key of new Set([raw.toUpperCase(), canonicalize(raw)])) {
      // Rows arrive newest first, so the first one wins and later (older)
      // scans of the same unit do not overwrite it.
      if (details[key]) continue;
      details[key] = {
        customer: (r.task_customer as string) ?? null,
        soNumber: (r.task_so as string) ?? null,
        ticketId: (r.task_ticket as string) ?? null,
        product: (r.unit_product as string) ?? null,
        matched: !!r.task_matched,
      };
    }
  }

  return NextResponse.json({ details });
});
