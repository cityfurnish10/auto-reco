// Odoo connector — Metabase-backed native SQL against the "Odoo Live Database"
// connection (Postgres, database id 5 at analytics.rentofurniture.com).
//
// ✅ Verified live (2026-07-15) against a real Odoo export ("BAN-system in
// out.xlsx", stock_move_line rows for BAN, 12–13 Jul). Key finding: this Odoo
// instance DENORMALIZES everything the reconciliation needs directly onto
// `stock_move_line` — no need to derive direction from picking types or
// locations:
//   - movement_type      → "In" / "Out" / "In Transit" (direction; we keep In/Out)
//   - procurement_status → "ok" / "new" / "damaged" / ... (the export's
//                          "Procurement Condition" column → jobType)
//   - reference          → picking ref, e.g. "BAN/IN/22557" (→ ticketId)
//   - sale_order_id      → FK to sale_order (→ so_number = the ON-RET-… number)
//   - product name lives in product_template.name as JSONB ({"en_US": "..."}),
//     so it must be extracted with ->>'en_US' (raw column is a translation map)
//
// Warehouse code (BAN/GUR/HYD/MUM/PUN) comes via picking → picking_type →
// warehouse and maps to the engine City in odoo-mapping.ts.
//
// Requires: METABASE_URL, METABASE_ODOO_DB_ID (=5), and either METABASE_API_KEY
// or METABASE_USERNAME + METABASE_PASSWORD.

import type { Connector, CityTaggedRow } from "./types";
import type { City } from "../sample-data";
import type { Direction } from "../engine/types";
import { canonicalize } from "../engine/barcode";
import { addDays } from "../engine/dates";
import {
  businessDayToUtcWindow,
  businessDaySpanToUtcWindow,
  utcToBusinessDate,
} from "./ist-window";
import { normalizeOdooWarehouse } from "./odoo-mapping";
import { metabaseConfigured, runNativeSql } from "./metabase";

// sml.date is the POSTING timestamp (Odoo stamps it at validation), not the
// physical movement date. Measured on real data (2026-07-12): 237/607 DT
// movements were posted same-day, 302 next-day, 0 the day before — so a pull
// restricted to a single day misses half of Odoo and floods the engine with
// false "Not in Odoo" variances. Pull [R-1 .. R+1] instead; the engine's
// odoo-window (§4) then filters by posting date, and its "Odoo-only" rung only
// fires for same-day postings (so R+1's own movements pulled here as
// match-targets never surface as false Odoo-only rows for R).
//
// NOTE: that same-day/next-day split was measured under the old MIDNIGHT day
// definition. Odoo is the one source with a real event timestamp, so it now
// runs on the 15:00 business day — which folds a chunk of what used to look
// like "next-day posting" into the same business date. The ±1 window is left
// as-is deliberately: it is a safety margin, and narrowing it is a separate
// exercise that needs its own measurement.
const POSTING_DAYS_BEFORE = 1;
const POSTING_DAYS_AFTER = 1;

// Native SQL, parameterized on the IST→UTC run-date window. Fetches both
// directions, done-only, across all warehouses in one query; city split +
// direction/jobType mapping happen in TS below.
function buildQuery(startUtc: string, endUtcExclusive: string): string {
  const start = startUtc.slice(0, 19).replace("T", " ");
  const end = endUtcExclusive.slice(0, 19).replace("T", " ");
  return `
SELECT
    sml.date                                        AS date,
    sml.create_date                                 AS record_created,
    sml.reference                                   AS ticket_id,
    so.name                                         AS so_number,
    -- The "Reference#" column in the Odoo UI, which is NOT sml.reference
    -- (that is the picking ref, BAN/OUT/58612). Order transfers carry
    -- 'OT-<date>-<n>' here; see the filter below.
    so.reference_no                                 AS reference_no,
    sl.name                                         AS barcode,
    pt.name ->> 'en_US'                             AS product,
    rp.name                                         AS customer,
    sw.code                                         AS warehouse_code,
    sml.movement_type                               AS direction,
    sml.procurement_status                          AS job_type
FROM stock_move_line sml
JOIN stock_picking          sp   ON sp.id  = sml.picking_id
JOIN stock_picking_type     spt  ON spt.id = sp.picking_type_id
JOIN stock_warehouse        sw   ON sw.id  = spt.warehouse_id
JOIN stock_lot              sl   ON sl.id  = sml.lot_id
JOIN product_product        pp   ON pp.id  = sml.product_id
JOIN product_template       pt   ON pt.id  = pp.product_tmpl_id
LEFT JOIN sale_order        so   ON so.id  = sml.sale_order_id
LEFT JOIN res_partner       rp   ON rp.id  = sp.partner_id
WHERE
    sml.state = 'done'
    AND sml.date >= '${start}'
    AND sml.date <  '${end}'
    AND sml.movement_type IN ('In', 'Out')
ORDER BY sml.date ASC;
`.trim();
}

// stock_move_line.movement_type → engine Direction. "In Transit" and null are
// already filtered out by the query; this maps the two we keep.
function toDirection(movementType: unknown): Direction | null {
  if (movementType === "In") return "IN";
  if (movementType === "Out") return "OUT";
  return null;
}

/**
 * An Odoo order transfer — a unit reassigned between orders inside Odoo, with
 * no physical movement. The UI shows this as "Reference#"; the column is
 * sale_order.reference_no, not sml.reference.
 */
export function isOrderTransfer(referenceNo: unknown): boolean {
  return /^OT-/i.test(String(referenceNo ?? "").trim());
}

// Trim so identifiers/text match across sources (Sheets/Guard already trim).
function str(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

export const odooConnector: Connector = {
  source: "ODOO",
  label: "Odoo ERP",
  async pull(runDate: string): Promise<CityTaggedRow[]> {
    if (!metabaseConfigured()) {
      throw new Error(
        "Odoo not configured (set METABASE_URL + METABASE_API_KEY, or METABASE_URL + METABASE_USERNAME + METABASE_PASSWORD)."
      );
    }
    const dbId = Number(process.env.METABASE_ODOO_DB_ID);
    if (!dbId) throw new Error("METABASE_ODOO_DB_ID not set.");

    const { startUtc, endUtcExclusive } = businessDaySpanToUtcWindow(
      runDate,
      POSTING_DAYS_BEFORE,
      POSTING_DAYS_AFTER
    );
    const table = await runNativeSql(dbId, buildQuery(startUtc, endUtcExclusive));

    const rows: CityTaggedRow[] = [];
    let orderTransfers = 0;
    for (const r of table.rows) {
      const city = normalizeOdooWarehouse(r.warehouse_code);
      const barcode = str(r.barcode);
      const direction = toDirection(r.direction);
      if (!city || !barcode || !direction) continue; // unknown warehouse/barcode/direction — skip

      // ORDER TRANSFERS — Odoo-only, never a stock gap.
      //
      // An order transfer moves a unit between orders inside Odoo. It is a
      // paperwork event: no truck leaves, so the gate register, the ops sheet
      // and the Delivery Tracker correctly have nothing. Reconciled normally it
      // becomes an "Odoo-only" chase item and sends someone hunting a unit that
      // never moved.
      //
      // Identified by sale_order.reference_no starting 'OT-' — the UI's
      // "Reference#", a different field from sml.reference. Verified against
      // SO ON-RET-BAN-85606 (reference_no OT-20260726-695913, barcode
      // FUMYWS25020034), which surfaced as a tier-1 System-Only Entry on
      // 2026-07-26. Measured: 152 of 16,300 done In/Out lines over 30 days.
      //
      // Dropped here rather than in SQL so the count is observable, and dropped
      // at the connector rather than suppressed in the engine because there is
      // nothing to reconcile — the row should never have been a movement.
      if (isOrderTransfer(r.reference_no)) {
        orderTransfers++;
        continue;
      }

      rows.push({
        source: "ODOO",
        city,
        direction,
        barcode,
        status: "done", // query already filters state = 'done'
        // `date` = the IST business date (uniform across all connectors).
        date: runDate,
        // `createdOn` = the BUSINESS date this row was POSTED in Odoo
        // (sml.date). The engine's §4 odoo-window keys off createdOn — it must
        // be the posting date, NOT create_date (which is order creation, often
        // weeks before the movement; feeding that in decimated Odoo coverage).
        // Business date, not calendar: this has to agree with the pull window
        // above, or a posting made after 15:00 would be pulled for one day and
        // then attributed to another.
        createdOn: utcToBusinessDate(r.date as string | null),
        // `recordCreatedOn` = the IST calendar date this stock_move_line RECORD
        // was created in Odoo (create_date, NOT sml.date). Used ONLY by the
        // engine's "Odoo-only" flag to tell a genuine same-day movement the
        // floor missed (record born today, no floor record → REAL) from a benign
        // late batch-post of an earlier movement (record older → INFO). It is
        // NEVER the odoo-window key — that stays the posting date above, so pull
        // coverage is unchanged (create_date runs 0–2 days ahead of posting).
        recordCreatedOn: utcToBusinessDate(r.record_created as string | null),
        movementDate: str(r.date),
        soNumber: str(r.so_number),
        ticketId: str(r.ticket_id),
        customer: str(r.customer),
        product: str(r.product),
        // procurement_status ("ok"/"new"/"damaged"/…) — this is Odoo's real
        // "Procurement Condition" field. NOTE (open business decision, DB
        // MODEL.md §10): these values don't map to the engine's REPAIR/REPLACE/
        // NEW_RENTAL vocabulary yet — passed through verbatim until confirmed.
        jobType: str(r.job_type),
      });
    }
    if (orderTransfers > 0) {
      // Visible in the run log rather than silently dropped: if this number
      // ever jumps, someone has started using order transfers for something
      // that IS a physical movement, and the engine would stop seeing it.
      console.info(
        `[odoo] skipped ${orderTransfers} order-transfer line(s) for ${runDate} (Reference# starts OT-) — reassignments inside Odoo, no physical movement.`
      );
    }
    return rows;
  },
};

/** Ceiling for the optional lookahead query. ~20x its measured 155-305ms. */
const LOOKAHEAD_TIMEOUT_MS = 5_000;

// Only what the lookahead needs. Deliberately NOT the pull query above: this
// answers one yes/no question per unit ("has Odoo posted this since?"), so it
// carries no customer, product or SO text and stays cheap even across four days.
function buildLookaheadQuery(startUtc: string, endUtcExclusive: string): string {
  const start = startUtc.slice(0, 19).replace("T", " ");
  const end = endUtcExclusive.slice(0, 19).replace("T", " ");
  return `
SELECT
    sl.name                                         AS barcode,
    sw.code                                         AS warehouse_code,
    sml.movement_type                               AS direction,
    so.reference_no                                 AS reference_no
FROM stock_move_line sml
JOIN stock_picking          sp   ON sp.id  = sml.picking_id
JOIN stock_picking_type     spt  ON spt.id = sp.picking_type_id
JOIN stock_warehouse        sw   ON sw.id  = spt.warehouse_id
JOIN stock_lot              sl   ON sl.id  = sml.lot_id
LEFT JOIN sale_order        so   ON so.id  = sml.sale_order_id
WHERE
    sml.state = 'done'
    AND sml.date >= '${start}'
    AND sml.date <  '${end}'
    AND sml.movement_type IN ('In', 'Out')
ORDER BY sml.date ASC;
`.trim();
}

/**
 * Canonical barcodes Odoo posted on the business days AFTER `runDate`, keyed
 * `${direction}::${canonical}` per city — the same shape as
 * loadRecentOdooPostings, so the two union.
 *
 * WHY A LIVE READ AND NOT MORE HISTORY. loadRecentOdooPostings answers the same
 * question from source_rows / movement_events, and on the run that matters it
 * cannot answer it at all: those tables only hold D+1 once D+1 has ITSELF been
 * reconciled, which happens a day or more after D's own run. Measured over the
 * 21 business dates 2026-07-20 … 2026-08-09, the first run of a date fired
 * before ANY forward day had been reconciled — 21 of 21. So on the primary pass
 * the history set is empty, every time, and ODOO_POSTED_LATE — the whole
 * mechanism built for vendor receipts — can only ever fire days later on a
 * re-check. The morning email is produced by the primary pass, so the warehouse
 * reads the version of the day with the false chase items still in it.
 *
 * That is what this closes — PARTLY, and the size of "partly" is the number to
 * know before trusting it.
 *
 * The primary run for business date D fires at 20:00 IST on D+2, so at that
 * instant D+3 has not started and D+2 is five hours old. D+1 is fully elapsed
 * but is already inside the ±1 pull, where it arrives as present_o and is
 * handled by the next-day rung — so the only days this ADDS are D+2 and D+3,
 * and much of that has not happened yet.
 *
 * MEASURE THAT AGAINST THE ACCUSED UNITS, NOT AGAINST ODOO'S TOTAL TRAFFIC.
 * Only 12% of all D+2/D+3 postings exist when the cron fires, and that number
 * is meaningless here: the demotion consumes only postings that match a unit
 * some floor book recorded and Odoo did not, and those are not spread evenly
 * across the window. The vendor catch-up batch posts in the 15:00-20:00 IST
 * slice, which is exactly the slice that exists at run time. Reachable
 * demotions landing on the primary pass, measured:
 *
 *     2026-08-06   118 of 220   (54%)  — 116 of them the Bangalore PO batch
 *     2026-08-07    40 of  56   (71%)
 *     2026-08-02     3 of   8   ·  2026-08-04   2 of 25  ·  2026-08-05  0 of 8
 *
 * So on the day this was built for it catches half, and on quiet days it can
 * catch none. Against a stored history that contributes exactly zero on every
 * primary pass, that is the whole of the gain.
 *
 * The lever that reaches the remainder is REPORTING_LAG_DAYS, not a wider
 * window: at a lag of 2 the run fires at 20:00 on D+3 and the same window is
 * 57-70% complete by volume. That is a freshness trade for the owner to make —
 * the digest would report the day before yesterday's yesterday — and it is
 * deliberately not smuggled in here.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never becomes presence. The pull window
 * above stays ±1 and filterOdooWindow stays ±1, so present_o keeps meaning what
 * it already means — "Odoo posted this within a day of the business date" —
 * rather than widening to four days, which would have the four-way check report
 * agreement that never happened. (±1 is itself a stretch of the word "present",
 * inherited deliberately: of the 55 rows the absence gate retires today, 54 have
 * a same-direction posting on the business date itself and 1 rests on a D+1
 * posting. That is the existing window, not something added here.) These keys feed
 * exactly one decision — refusing to tell a warehouse to post an entry that
 * demonstrably already exists — and they arrive as a demotion to INFO with the
 * "posted a few days on" name, never as a silent drop.
 *
 * Best-effort by contract: the caller swallows failures, because a lookahead
 * that does not answer costs a demotion, and a reconcile that dies costs a day.
 */
export async function fetchOdooPostingsAfter(
  runDate: string,
  days: number
): Promise<Partial<Record<City, Set<string>>>> {
  const out: Partial<Record<City, Set<string>>> = {};
  if (days < 1) return out;
  if (!metabaseConfigured()) return out;
  const dbId = Number(process.env.METABASE_ODOO_DB_ID);
  if (!dbId) return out;

  // [D+1 .. D+days] of whole business days. Written as two window calls rather
  // than a negative daysBefore so the range is readable at the call site.
  const startUtc = businessDayToUtcWindow(addDays(runDate, 1)).startUtc;
  const endUtcExclusive = businessDayToUtcWindow(addDays(runDate, days)).endUtcExclusive;

  // Timed out where the main pull is not. This query is optional — losing it
  // costs a demotion, and the caller treats a failure as "no evidence" — so it
  // must never be the thing that eats the 60s function ceiling. Measured median
  // 155-305ms against live Odoo, so five seconds is ~20x the observed cost.
  const table = await runNativeSql(
    dbId,
    buildLookaheadQuery(startUtc, endUtcExclusive),
    LOOKAHEAD_TIMEOUT_MS
  );
  let skipped = 0;
  for (const r of table.rows) {
    const city = normalizeOdooWarehouse(r.warehouse_code);
    const barcode = str(r.barcode);
    const direction = toDirection(r.direction);
    if (!city || !barcode || !direction) {
      skipped++;
      continue;
    }
    // Same exclusion as the pull: an order transfer is paperwork, so it can
    // never be the "the entry was made after all" evidence this set stands for.
    if (isOrderTransfer(r.reference_no)) {
      skipped++;
      continue;
    }
    (out[city] ??= new Set()).add(`${direction}::${canonicalize(barcode)}`);
  }
  // Counted for the same reason the pull counts its own drops: a set that
  // silently shrinks looks exactly like a quiet day. Measured 44 of 1,790 rows
  // (2.5%) dropped as order transfers on 2026-08-06 — normal; a jump is not.
  if (skipped > 0) {
    console.info(
      `[odoo] lookahead for ${runDate}: ${table.rows.length} posting(s) in +1…+${days}, ${skipped} skipped (order transfer, unknown warehouse, or no barcode/direction).`
    );
  }
  return out;
}
