// What a scanned serial IS, looked up from Odoo's lot master.
//
// THE RULE THIS MODULE EXISTS TO KEEP. The gate is the fourth witness, and it
// is only worth having because it is INDEPENDENT. Enriching a scan from
// gate_expected_items — the day's planned pickings — would make it agree with
// Odoo about today by construction, which is the same failure COMPLETENESS_SHOWN
// refuses in the UI, arriving through the database instead.
//
// So the lookup is deliberately narrow: given a serial, what is this unit, and
// where has it BEEN. Never where it is going. A dictionary lookup, not a
// verification.
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

import { runNativeSql } from "../connectors/metabase";

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
