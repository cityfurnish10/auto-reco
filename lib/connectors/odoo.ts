// Odoo connector — STUB. Transport (direct Postgres via `pg` vs Odoo JSON-RPC)
// is deferred (see DB_Plan.md). The interface is fixed so the rest of the
// pipeline is already wired; only mapStockMove() + the transport call are TODO.
//
// Maps Odoo stock moves → SourceRow{ source: "ODOO", createdOn, jobType, ... }.

import type { Connector, CityTaggedRow } from "./types";

export const odooConnector: Connector = {
  source: "ODOO",
  label: "Odoo ERP",
  async pull(_runDate: string): Promise<CityTaggedRow[]> {
    const configured = !!(process.env.ODOO_PG_URL || process.env.ODOO_URL);
    if (!configured) {
      throw new Error("Odoo not configured (set ODOO_PG_URL or ODOO_URL).");
    }
    // TODO (Phase 7): pull stock moves for runDate (± the per-city Odoo window
    // is applied later by the engine) and map each to a CityTaggedRow with
    // source:"ODOO", createdOn/movementDate, jobType (REPAIR|REPLACE|NEW_RENTAL),
    // barcode, soNumber, ticketId, customer, product, direction (IN/OUT).
    throw new Error("Odoo connector transport not implemented yet.");
  },
};
