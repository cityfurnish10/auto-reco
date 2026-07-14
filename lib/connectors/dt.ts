// Delivery Tracker connector — MongoDB (Atlas `cityfurnish` DB). Connection is
// verified working. The movement data lives in `deliveries` (~174k) / `trips`
// (~159k). Connection + windowing are wired here; mapDoc() carries a best-effort
// field mapping that MUST be confirmed against a real document (Phase 6) — the
// exact field names are set via env so they can be corrected without a code change.
//
// Requires: DT_MONGODB_URI (full connection string), DT_MONGODB_DB (default
// "cityfurnish"). Node runtime only (uses the `mongodb` driver).

import { MongoClient } from "mongodb";
import type { Connector, CityTaggedRow } from "./types";
import { normalizeCity } from "./types";
import type { Direction } from "../engine/types";

// Field-name overrides so the mapping can be corrected via env, not code.
const F = {
  collection: process.env.DT_COLLECTION ?? "deliveries",
  barcode: process.env.DT_FIELD_BARCODE ?? "barcode",
  status: process.env.DT_FIELD_STATUS ?? "status",
  city: process.env.DT_FIELD_CITY ?? "city",
  direction: process.env.DT_FIELD_DIRECTION ?? "direction",
  date: process.env.DT_FIELD_DATE ?? "date",
  so: process.env.DT_FIELD_SO ?? "so_number",
  ticket: process.env.DT_FIELD_TICKET ?? "ticket_id",
  customer: process.env.DT_FIELD_CUSTOMER ?? "customer",
  product: process.env.DT_FIELD_PRODUCT ?? "product",
};

function pick(doc: Record<string, unknown>, key: string): string | undefined {
  const v = doc[key];
  return v == null ? undefined : String(v);
}

function toDirection(raw: unknown): Direction {
  const s = String(raw ?? "").toLowerCase();
  // Deliveries are dispatches (OUT); pickups/returns are IN. Adjust in Phase 6
  // once the real direction/movement-type field is confirmed.
  if (s.includes("in") || s.includes("pickup") || s.includes("return")) return "IN";
  return "OUT";
}

export const dtConnector: Connector = {
  source: "DT",
  label: "Delivery Tracker",
  async pull(runDate: string): Promise<CityTaggedRow[]> {
    const uri = process.env.DT_MONGODB_URI;
    if (!uri) throw new Error("DT not configured (set DT_MONGODB_URI).");

    const dbName = process.env.DT_MONGODB_DB ?? "cityfurnish";
    const client = new MongoClient(uri);
    try {
      await client.connect();
      const coll = client.db(dbName).collection(F.collection);

      // Window to the run date (string prefix match tolerates ISO/date strings;
      // refine to a real date range on the confirmed date field in Phase 6).
      const cursor = coll.find(
        { [F.date]: { $regex: `^${runDate}` } },
        { projection: { _id: 0 } }
      );

      const rows: CityTaggedRow[] = [];
      for await (const raw of cursor) {
        const doc = raw as Record<string, unknown>;
        const city = normalizeCity(doc[F.city]);
        const barcode = pick(doc, F.barcode);
        if (!city || !barcode) continue; // skip rows we can't place/identify

        rows.push({
          source: "DT",
          city,
          direction: toDirection(doc[F.direction]),
          barcode,
          status: pick(doc, F.status),
          date: pick(doc, F.date),
          soNumber: pick(doc, F.so),
          ticketId: pick(doc, F.ticket),
          customer: pick(doc, F.customer),
          product: pick(doc, F.product),
        });
      }
      return rows;
    } finally {
      await client.close();
    }
  },
};
