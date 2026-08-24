// Today's expected pickings, pulled from Odoo and cached for the phone.
//
// SERIALS ON PLANNED MOVES. Confirmed with operations 2026-08-22: every planned
// movement in Odoo carries the item's barcode, so the scan the guard makes has
// something to match against. That resolves the question this module was
// originally written around.
//
// One distinction survives it, and it is why the probe below reports BY STATE
// rather than as a single number:
//
//   assigned   reserved and ready. Odoo picks the specific unit at reservation,
//              so the lot is set and these are the rows the check relies on.
//   confirmed  waiting on stock. Nothing is reserved yet, so a lot may not
//              exist to attach — through no fault of anyone's.
//
// Both are pulled: a same-day confirmation can still go out, and a row with no
// serial is simply skipped rather than dropped silently — it is counted, so the
// size of that gap is visible instead of guessed at.
//
// EXPECTED_CHECK_LIVE stays false for the pilot anyway, for a DIFFERENT reason
// than Odoo coverage: an item added to a load without any planned picking at
// all would warn even against a perfect list. Whether that happens often is an
// operational question, not a data one, and silent mode is how it gets answered
// before a guard is taught to dismiss warnings.
//
// Refreshed each morning into gate_expected_items so three phones at shift
// change do not each pay a multi-second Metabase round trip.

import type { SupabaseClient } from "@supabase/supabase-js";
import { metabaseConfigured, runNativeSql } from "../connectors/metabase";
import { normalizeOdooWarehouse } from "../connectors/odoo-mapping";
import { businessDayToUtcWindow } from "../connectors/ist-window";
import { canonicalize } from "../engine/barcode";
import type { City } from "../sample-data";
import type { Direction } from "../engine/types";

/** Ceiling for this query — it is optional to the run and must never eat the
 *  function budget the way an unbounded Metabase call can. */
const TIMEOUT_MS = 20_000;

/**
 * Pickings that are READY OR CONFIRMED but not yet done, scheduled for the day.
 *
 * `assigned` is "reserved and ready to pick" and is the state that matters;
 * `confirmed` is "waiting on stock" and is included because a same-day
 * confirmation can still go out. `done` is deliberately excluded — a completed
 * move is history, and the gate is asking what is still to come.
 */
function buildQuery(startUtc: string, endUtcExclusive: string): string {
  const start = startUtc.slice(0, 19).replace("T", " ");
  const end = endUtcExclusive.slice(0, 19).replace("T", " ");
  return `
SELECT
    sl.name                       AS barcode,
    pt.name ->> 'en_US'           AS product,
    so.name                       AS so_number,
    sml.reference                 AS ticket_id,
    rp.name                       AS customer,
    sp.name                       AS picking_ref,
    sw.code                       AS warehouse_code,
    sml.movement_type             AS direction,
    sml.procurement_status        AS job_type,
    sml.state                     AS move_state
FROM stock_move_line sml
JOIN stock_picking          sp   ON sp.id  = sml.picking_id
JOIN stock_picking_type     spt  ON spt.id = sp.picking_type_id
JOIN stock_warehouse        sw   ON sw.id  = spt.warehouse_id
JOIN product_product        pp   ON pp.id  = sml.product_id
JOIN product_template       pt   ON pt.id  = pp.product_tmpl_id
-- LEFT, not JOIN: an unassigned serial is the case we need to SEE rather than
-- silently filter away. Rows with no lot are dropped in TS and counted, so the
-- coverage probe below can report how big that hole actually is.
LEFT JOIN stock_lot         sl   ON sl.id  = sml.lot_id
LEFT JOIN sale_order        so   ON so.id  = sml.sale_order_id
LEFT JOIN res_partner       rp   ON rp.id  = sp.partner_id
WHERE
    sml.state IN ('assigned','confirmed')
    AND sp.scheduled_date >= '${start}'
    AND sp.scheduled_date <  '${end}'
    AND sml.movement_type IN ('In','Out')
ORDER BY sp.scheduled_date ASC;
`.trim();
}

export interface ExpectedRow {
  city: City;
  direction: Direction;
  barcode: string;
  product: string | null;
  soNumber: string | null;
  ticketId: string | null;
  customer: string | null;
  pickingRef: string | null;
  jobType: string | null;
}

export interface ExpectedPull {
  rows: ExpectedRow[];
  /** Planned lines whose serial is not yet assigned — the coverage hole. */
  withoutSerial: number;
  total: number;
  /** Per Odoo state, because `assigned` and `confirmed` behave differently. */
  byState: Record<string, { total: number; withSerial: number }>;
}

export async function fetchExpected(businessDate: string): Promise<ExpectedPull> {
  if (!metabaseConfigured()) throw new Error("Metabase is not configured");
  const dbId = Number(process.env.METABASE_ODOO_DB_ID);
  if (!Number.isFinite(dbId)) throw new Error("METABASE_ODOO_DB_ID is not set");

  const { startUtc, endUtcExclusive } = businessDayToUtcWindow(businessDate);
  const table = await runNativeSql(dbId, buildQuery(startUtc, endUtcExclusive), TIMEOUT_MS);

  const rows: ExpectedRow[] = [];
  const byState: Record<string, { total: number; withSerial: number }> = {};
  let withoutSerial = 0;
  for (const r of table.rows) {
    const city = normalizeOdooWarehouse(r.warehouse_code);
    if (!city) continue;
    const st = String(r.move_state ?? "unknown");
    (byState[st] ??= { total: 0, withSerial: 0 }).total++;
    const barcode = String(r.barcode ?? "").trim();
    if (!barcode) { withoutSerial++; continue; }
    byState[st].withSerial++;
    const direction: Direction | null =
      r.direction === "In" ? "IN" : r.direction === "Out" ? "OUT" : null;
    if (!direction) continue;
    rows.push({
      city, direction, barcode,
      product: (r.product as string) ?? null,
      soNumber: (r.so_number as string) ?? null,
      ticketId: (r.ticket_id as string) ?? null,
      customer: (r.customer as string) ?? null,
      pickingRef: (r.picking_ref as string) ?? null,
      jobType: (r.job_type as string) ?? null,
    });
  }
  return { rows, withoutSerial, total: table.rows.length, byState };
}

/** Replace a day's cache. Delete-then-insert so a picking that was cancelled
 *  disappears rather than lingering as a phantom expectation. */
export async function refreshExpected(
  admin: SupabaseClient,
  businessDate: string
): Promise<{ written: number; withoutSerial: number; total: number }> {
  const pull = await fetchExpected(businessDate);
  await admin.from("gate_expected_items").delete().eq("business_date", businessDate);

  const payload = pull.rows.map((r) => ({
    city: r.city,
    business_date: businessDate,
    direction: r.direction,
    barcode: r.barcode,
    // The fold alongside the true spelling, so a scanned QR still matches a row
    // whose Odoo spelling differs only by a confusable character.
    barcode_canon: canonicalize(r.barcode),
    product: r.product,
    so_number: r.soNumber,
    ticket_id: r.ticketId,
    customer: r.customer,
    picking_ref: r.pickingRef,
    job_type: r.jobType,
  }));

  let written = 0;
  for (let i = 0; i < payload.length; i += 500) {
    const chunk = payload.slice(i, i + 500);
    const { error } = await admin
      .from("gate_expected_items")
      .upsert(chunk, { onConflict: "city,business_date,direction,barcode" });
    if (error) throw new Error(`refreshExpected: ${error.message}`);
    written += chunk.length;
  }
  return { written, withoutSerial: pull.withoutSerial, total: pull.total };
}

/**
 * What share of planned lines actually carry a serial, split by Odoo state.
 *
 * Reported as ratios rather than a verdict. If `confirmed` turns out to be the
 * only weak band, the fix is to stop pulling that state rather than to abandon
 * the check — and that is a decision this module should surface, not make.
 */
export async function probeExpectedCoverage(businessDate: string) {
  const p = await fetchExpected(businessDate);
  return {
    businessDate,
    plannedLines: p.total,
    withSerial: p.rows.length,
    withoutSerial: p.withoutSerial,
    coverage: p.total ? +(p.rows.length / p.total).toFixed(3) : null,
    byState: Object.fromEntries(
      Object.entries(p.byState).map(([k, v]) => [
        k, { ...v, coverage: v.total ? +(v.withSerial / v.total).toFixed(3) : null },
      ])
    ),
  };
}
