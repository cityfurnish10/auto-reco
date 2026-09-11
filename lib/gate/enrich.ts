// What a scanned serial IS, looked up from Odoo's lot master.
//
// THE RULE THIS MODULE EXISTS TO KEEP. The gate is the fourth witness, and it
// is only worth having because it is INDEPENDENT. Enriching a scan from
// gate_expected_items — the day's planned pickings — would make it agree with
// Odoo about today by construction, which is the same failure COMPLETENESS_SHOWN
// refuses in the UI, arriving through the database instead.
//
// So the Odoo lookup is deliberately narrow: given a serial, what is this unit,
// and where has it BEEN. A dictionary lookup, not a verification. The DT half
// at the bottom of this file (ticket, job type, customer) is closer to the plan,
// and is only acceptable because of where both answers are written — columns a
// manager reads and the engine and the guard never do.
//
// Measured on the first real run, 2026-09-10, over all 38 serialised scans the
// pilot had recorded:
//
//   product          38/38  100%
//   last customer    36/38   95%   real customers AND vendors (WAKEFIT
//                                  INNOVATIONS on inbound units, say) — both
//                                  are facts about the unit, both useful
//   last SO          25/38   66%
//
// An earlier note here said customer and SO resolved "about a third of the
// time". That came from hand-picking three serials, and was wrong — kept in
// this comment because the lesson is the reusable part: three rows is an
// anecdote, and this file is exactly where a made-up-sounding number does
// damage.
//
// Product is still the field to rely on, and the rest is still a chase hint
// rather than evidence — that has not changed, only the odds. Nothing here is
// written to the columns the reconciliation reads; see migration 0037 for that
// separation and why it is load bearing.

import { runMongoPipeline, runNativeSql } from "../connectors/metabase";
import { dtDatabaseId } from "./fleet";

export interface UnitFacts {
  serial: string;
  product: string | null;
  sku: string | null;
  lastCustomer: string | null;
  lastSo: string | null;
  lastDirection: string | null;
  lastMovedAt: string | null;
}

/**
 * Metabase native SQL has no bind parameters, so serials are interpolated. A
 * barcode arrives from a QR code a guard pointed a camera at, which means an
 * attacker can choose its contents by printing a sticker — so this is filtered,
 * not escaped, and the filter lives INSIDE unitFactsSql rather than in a caller.
 * Safe by construction beats safe-if-called-correctly: the next person to use
 * the query builder does not have to know about the wrapper.
 *
 * A serial that is not plain alphanumerics cannot be an Odoo lot name anyway,
 * so nothing is lost by refusing to ask about it.
 */
const SAFE = /^[A-Za-z0-9._-]{4,32}$/;

/** The serials worth asking Odoo about: deduplicated, trimmed, plausible. */
export function askable(serials: string[]): string[] {
  return [...new Set(serials.map((s) => String(s ?? "").trim()).filter((s) => SAFE.test(s)))];
}

/**
 * Wall-clock ceiling. Enrichment is entirely optional: a scan without it is
 * still a complete record of a unit crossing a gate. A Metabase stall must cost
 * this lookup and nothing else — the same reasoning runNativeSql's own timeout
 * comment gives for the nightly run.
 */
const TIMEOUT_MS = 20_000;

export function odooDbId(): number {
  return Number(process.env.METABASE_ODOO_DB_ID ?? 5);
}

/**
 * DISTINCT ON picks each serial's most recent completed movement, so one query
 * answers both halves: the lot master join gives identity (always present), the
 * movement row gives the last-known context (often not). LEFT JOINs throughout
 * because a unit that has never moved still has a product, and that alone is
 * worth storing.
 */
export function unitFactsSql(serials: string[]): string {
  const safe = askable(serials);
  if (safe.length === 0) return "";
  const list = safe.map((s) => `'${s}'`).join(",");
  return `
SELECT DISTINCT ON (sl.name)
  sl.name                 AS serial,
  pt.name ->> 'en_US'     AS product,
  pt.default_code         AS sku,
  rp.name                 AS last_customer,
  so.name                 AS last_so,
  sml.movement_type       AS last_direction,
  sml.date::date          AS last_moved_at
FROM stock_lot sl
JOIN product_product  pp  ON pp.id = sl.product_id
JOIN product_template pt  ON pt.id = pp.product_tmpl_id
LEFT JOIN stock_move_line sml ON sml.lot_id = sl.id AND sml.state = 'done'
LEFT JOIN stock_picking   sp  ON sp.id = sml.picking_id
LEFT JOIN res_partner     rp  ON rp.id = sp.partner_id
LEFT JOIN sale_order      so  ON so.id = sml.sale_order_id
WHERE sl.name IN (${list})
ORDER BY sl.name, sml.date DESC NULLS LAST`.trim();
}

/**
 * Look up a batch of serials. Returns only what Odoo knew about; a serial with
 * no row simply does not appear, and the caller still marks it attempted so an
 * unknown unit is not retried forever.
 *
 * Never throws for a data reason — an empty map means "we learned nothing this
 * time", which is a normal outcome and must not fail a caller.
 */
export async function fetchUnitFacts(serials: string[]): Promise<Map<string, UnitFacts>> {
  const out = new Map<string, UnitFacts>();
  const sql = unitFactsSql(serials);
  if (sql === "") return out;

  const { rows } = await runNativeSql(odooDbId(), sql, TIMEOUT_MS);
  for (const r of rows as Record<string, unknown>[]) {
    const serial = String(r.serial ?? "").trim();
    if (!serial) continue;
    const str = (v: unknown) => {
      const s = v == null ? "" : String(v).trim();
      return s === "" ? null : s;
    };
    out.set(serial, {
      serial,
      product: str(r.product),
      sku: str(r.sku),
      lastCustomer: str(r.last_customer),
      lastSo: str(r.last_so),
      lastDirection: str(r.last_direction),
      // Odoo returns a timestamp even for a date cast; keep the date half only.
      lastMovedAt: str(r.last_moved_at)?.slice(0, 10) ?? null,
    });
  }
  return out;
}

/* ── The unit's most recent DT task (migration 0039) ─────────────────────── */

// Ticket and job type exist only in the Delivery Tracker — Odoo's "reference"
// is its own transfer number, not a ticket — and DT's customer is the person
// the task was for, where Odoo's partner is often a vendor. So this is the
// second half of the lookup, and it reads a different system.
//
// It is closer to the plan than the Odoo half: a unit at the gate today usually
// has today's task as its most recent one. Accepted because of where the answer
// goes — gate_scans.task_*, which a manager reads and neither the guard's phone
// nor the reconciliation ever does. See 0039.

export interface UnitTask {
  serial: string;
  ticket: string | null;
  jobType: string | null;
  customer: string | null;
  so: string | null;
  city: string | null;
}

/**
 * One aggregation for a batch of serials. Newest item record per barcode, then
 * the task it belongs to — the pickup if there is one (a pickup always comes
 * after the delivery in a unit's life), otherwise the delivery.
 *
 * $convert rather than $toObjectId: a malformed id must cost that one row its
 * ticket, not throw and cost the whole batch.
 */
export function unitTaskPipeline(serials: string[]): unknown[] | null {
  const safe = askable(serials);
  if (safe.length === 0) return null;
  return [
    { $match: { barcode: { $in: safe } } },
    { $sort: { updatedAt: -1 } },
    { $group: { _id: "$barcode", it: { $first: "$$ROOT" } } },
    {
      $lookup: {
        from: "deliveries",
        let: { d: { $convert: {
          input: { $ifNull: ["$it.pickup_deliveryId", "$it.deliveryId"] },
          to: "objectId", onError: null, onNull: null,
        } } },
        pipeline: [
          { $match: { $expr: { $eq: ["$_id", "$$d"] } } },
          { $project: { ticketNumber: 1, jobType: 1, firstName: 1, lastName: 1, city: 1 } },
        ],
        as: "dv",
      },
    },
    { $unwind: { path: "$dv", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0, serial: "$_id", so: "$it.Sale_Order",
        ticket: "$dv.ticketNumber", jobType: "$dv.jobType", city: "$dv.city",
        customer: { $trim: { input: { $concat: [
          { $ifNull: ["$dv.firstName", ""] }, " ", { $ifNull: ["$dv.lastName", ""] },
        ] } } },
      },
    },
  ];
}

/** Same contract as fetchUnitFacts: only what DT knew, never throws for data. */
export async function fetchUnitTasks(serials: string[]): Promise<Map<string, UnitTask>> {
  const out = new Map<string, UnitTask>();
  const pipeline = unitTaskPipeline(serials);
  if (!pipeline) return out;

  const { rows } = await runMongoPipeline(dtDatabaseId(), "orderfromcityfurnishes", pipeline, TIMEOUT_MS);
  const str = (v: unknown) => {
    const s = v == null ? "" : String(v).replace(/\s+/g, " ").trim();
    return s === "" || s.toLowerCase() === "null" ? null : s;
  };
  for (const r of rows as Record<string, unknown>[]) {
    const serial = str(r.serial);
    if (!serial) continue;
    out.set(serial, {
      serial, ticket: str(r.ticket), jobType: str(r.jobType),
      customer: str(r.customer), so: str(r.so), city: str(r.city),
    });
  }
  return out;
}
