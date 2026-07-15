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
import type { Direction } from "../engine/types";
import { istDayToUtcWindow } from "./ist-window";
import { normalizeOdooWarehouse } from "./odoo-mapping";
import { metabaseConfigured, runNativeSql } from "./metabase";

// Native SQL, parameterized on the IST→UTC run-date window. Fetches both
// directions, done-only, across all warehouses in one query; city split +
// direction/jobType mapping happen in TS below.
function buildQuery(startUtc: string, endUtcExclusive: string): string {
  const start = startUtc.slice(0, 19).replace("T", " ");
  const end = endUtcExclusive.slice(0, 19).replace("T", " ");
  return `
SELECT
    sml.date                                        AS date,
    sml.create_date                                 AS created_on,
    sml.write_date                                  AS movement_date,
    sml.reference                                   AS ticket_id,
    so.name                                         AS so_number,
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

    const { startUtc, endUtcExclusive } = istDayToUtcWindow(runDate);
    const table = await runNativeSql(dbId, buildQuery(startUtc, endUtcExclusive));

    const rows: CityTaggedRow[] = [];
    for (const r of table.rows) {
      const city = normalizeOdooWarehouse(r.warehouse_code);
      const barcode = str(r.barcode);
      const direction = toDirection(r.direction);
      if (!city || !barcode || !direction) continue; // unknown warehouse/barcode/direction — skip

      rows.push({
        source: "ODOO",
        city,
        direction,
        barcode,
        status: "done", // query already filters state = 'done'
        // `date` = the IST business date (uniform across all connectors — all
        // emit runDate; sml.date is windowed to this IST day anyway). The
        // full-precision UTC timestamps stay in createdOn/movementDate (the
        // Odoo-window rule keys off createdOn, so it must retain time-of-day).
        date: runDate,
        createdOn: str(r.created_on),
        movementDate: str(r.movement_date),
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
    return rows;
  },
};
