// Odoo connector — Metabase-backed (native SQL against the "Odoo Live
// Database" connection, confirmed accessible per DB MODEL.md §1/§10). Direct
// Postgres or JSON-RPC transport remain valid alternatives — DB_Plan.md left
// the choice deferred; if you switch, only pull() below needs to change, the
// SourceRow mapping (DB MODEL.md §7) stays the same either way.
//
// Requires: METABASE_URL, one of {METABASE_API_KEY} or
// {METABASE_USERNAME + METABASE_PASSWORD}, and METABASE_ODOO_DB_ID (the
// numeric database id Metabase assigns to "Odoo Live Database" — look this up
// via GET /api/database once authenticated; DB MODEL.md confirms DT's id is 6
// but doesn't give Odoo's).

import type { Connector, CityTaggedRow } from "./types";
import { istDayToUtcWindow } from "./ist-window";
import { normalizeOdooWarehouse } from "./odoo-mapping";
import { metabaseConfigured, runNativeSql } from "./metabase";

// SQL from DB MODEL.md §6, parameterized on the IST→UTC run-date window.
// Fetches both directions, done-only, across all warehouses/cities in one
// query — city split happens in TS below (§8), matching the doc's guidance.
function buildQuery(startUtc: string, endUtcExclusive: string): string {
  const start = startUtc.slice(0, 19).replace("T", " ");
  const end = endUtcExclusive.slice(0, 19).replace("T", " ");
  return `
SELECT
    sml.date                                        AS date,
    sml.create_date                                 AS created_on,
    sp.origin                                       AS so_number,
    sp.name                                         AS ticket_id,
    sl.name                                         AS barcode,
    pt.name                                         AS product,
    rp.name                                         AS customer,
    sw.code                                         AS warehouse_code,
    CASE
        WHEN spt.code = 'incoming' THEN 'IN'
        WHEN spt.code = 'outgoing' THEN 'OUT'
        ELSE spt.code
    END                                              AS direction,
    sm.procure_method                               AS job_type
FROM stock_move_line sml
JOIN stock_picking          sp   ON sp.id  = sml.picking_id
JOIN stock_picking_type     spt  ON spt.id = sp.picking_type_id
JOIN stock_warehouse        sw   ON sw.id  = spt.warehouse_id
JOIN stock_lot              sl   ON sl.id  = sml.lot_id
JOIN product_product        pp   ON pp.id  = sml.product_id
JOIN product_template       pt   ON pt.id  = pp.product_tmpl_id
LEFT JOIN res_partner       rp   ON rp.id  = sp.partner_id
LEFT JOIN stock_move        sm   ON sm.id  = sml.move_id
WHERE
    sml.state = 'done'
    AND sml.date >= '${start}'
    AND sml.date <  '${end}'
    AND spt.code IN ('incoming', 'outgoing')
ORDER BY sml.date ASC;
`.trim();
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
      const barcode = r.barcode != null ? String(r.barcode) : undefined;
      const direction = r.direction === "IN" || r.direction === "OUT" ? r.direction : null;
      if (!city || !barcode || !direction) continue; // unknown warehouse/barcode/direction

      rows.push({
        source: "ODOO",
        city,
        direction,
        barcode,
        status: "done", // query already filters state = 'done'
        date: r.date != null ? String(r.date) : undefined,
        createdOn: r.created_on != null ? String(r.created_on) : undefined,
        movementDate: r.date != null ? String(r.date) : undefined,
        soNumber: r.so_number != null ? String(r.so_number) : undefined,
        ticketId: r.ticket_id != null ? String(r.ticket_id) : undefined,
        customer: r.customer != null ? String(r.customer) : undefined,
        product: r.product != null ? String(r.product) : undefined,
        // NOTE (DB MODEL.md §10, open decision): procure_method values
        // ("Ok"/"New") don't match the engine's REPAIR/REPLACE/NEW_RENTAL
        // vocabulary yet — revisit once Odoo admin confirms the real field.
        jobType: r.job_type != null ? String(r.job_type) : undefined,
      });
    }
    return rows;
  },
};
