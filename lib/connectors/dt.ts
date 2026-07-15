// Delivery Tracker connector — MongoDB (Atlas `cityfurnish` DB). Implements
// the aggregation from DB MODEL.md §18: tasks + orderfromcityfurnishes
// (barcode lines), done-only filtered (§15), direction derived per §14.
//
// ⚠️ KNOWN ISSUE (2026-07-14): on the currently-configured DT_MONGODB_URI, the
// `tasks` collection is empty (0 docs) even though `orderfromcityfurnishes`
// is fully populated (327k docs, barcodes present). This connector is correct
// against the schema in DB MODEL.md, but will return 0 rows until either (a)
// DT_MONGODB_URI is corrected to point at an environment where `tasks` is
// populated, or (b) this is switched to read through Metabase's "Delivery
// Tracker MongoDB" connection (DB id 6) instead, which is confirmed live via
// saved cards 317/404/564. See PHASE_STATUS.md for the current state.
//
// Requires: DT_MONGODB_URI (full connection string), DT_MONGODB_DB (default
// "cityfurnish"). Node runtime only (uses the `mongodb` driver).

import { MongoClient } from "mongodb";
import type { Connector, CityTaggedRow } from "./types";
import { normalizeCity } from "./types";
import { istDayToUtcWindow } from "./ist-window";
import { deriveDtDirection, DT_EXCLUDED_JOB_TYPES } from "./dt-mapping";

function str(v: unknown): string | undefined {
  return v == null ? undefined : String(v);
}

export const dtConnector: Connector = {
  source: "DT",
  label: "Delivery Tracker",
  async pull(runDate: string): Promise<CityTaggedRow[]> {
    const uri = process.env.DT_MONGODB_URI;
    if (!uri) throw new Error("DT not configured (set DT_MONGODB_URI).");

    const dbName = process.env.DT_MONGODB_DB ?? "cityfurnish";
    const { startUtc, endUtcExclusive } = istDayToUtcWindow(runDate);

    const client = new MongoClient(uri);
    try {
      await client.connect();
      const db = client.db(dbName);

      // Mirrors DB MODEL.md §18 (users/agent join dropped — agentName isn't
      // consumed by SourceRow; add back if source_rows.raw ever captures it).
      const pipeline = [
        {
          $match: {
            scheduledDate: {
              $gte: new Date(startUtc),
              $lt: new Date(endUtcExclusive),
            },
            email: { $not: { $regex: "cityfurnish\\.com$", $options: "i" } },
            $nor: [
              { firstName: { $regex: "cityfurnish", $options: "i" } },
              { lastName: { $regex: "cityfurnish", $options: "i" } },
            ],
            jobType: { $nin: DT_EXCLUDED_JOB_TYPES },
          },
        },
        {
          $addFields: {
            customerName: {
              $concat: [
                { $ifNull: ["$firstName", ""] },
                " ",
                { $ifNull: ["$lastName", ""] },
              ],
            },
          },
        },
        {
          $lookup: {
            from: "orderfromcityfurnishes",
            let: {
              taskId: {
                $convert: { input: "$_id", to: "objectId", onError: null, onNull: null },
              },
            },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $or: [
                      { $eq: ["$pickup_deliveryId", "$$taskId"] },
                      { $eq: ["$deliveryId", "$$taskId"] },
                    ],
                  },
                },
              },
            ],
            as: "items",
          },
        },
        { $unwind: { path: "$items", preserveNullAndEmptyArrays: false } },
        // Done-only rule (§15) — only physical status "2" enters the engine.
        { $match: { "items.status": "2" } },
        {
          $project: {
            _id: 0,
            ticketId: "$ticketNumber",
            soNumber: { $ifNull: ["$items.Sale_Order", "$cf_odoo_id"] },
            customer: "$customerName",
            product: "$items.Product_name",
            jobType: "$jobType",
            barcode: "$items.barcode",
            city: "$city",
            movementDate: "$items.updatedAt",
            createdOn: "$createdAt",
            category: "$category",
            subCategory: "$subCategory",
            movement: "$movement",
            clientStatus: "$items.client_Status",
            hasDeliveryId: {
              $cond: [{ $gt: [{ $ifNull: ["$items.deliveryId", null] }, null] }, true, false],
            },
            hasPickupDeliveryId: {
              $cond: [
                { $gt: [{ $ifNull: ["$items.pickup_deliveryId", null] }, null] },
                true,
                false,
              ],
            },
          },
        },
      ];

      const rows: CityTaggedRow[] = [];
      const cursor = db.collection("tasks").aggregate(pipeline);
      for await (const raw of cursor) {
        const doc = raw as Record<string, unknown>;

        const city = normalizeCity(doc.city);
        const barcode = str(doc.barcode);
        if (!city || !barcode) continue; // unknown city or no barcode — skip

        const direction = deriveDtDirection({
          category: doc.category as string | undefined,
          jobType: doc.jobType as string | undefined,
          subCategory: doc.subCategory as string | undefined,
          movement: doc.movement as string | undefined,
          clientStatus: doc.clientStatus as string | undefined,
          hasDeliveryId: !!doc.hasDeliveryId,
          hasPickupDeliveryId: !!doc.hasPickupDeliveryId,
        });
        if (!direction) continue; // ambiguous (§14 rule 6) — skip

        const movementDate = str(doc.movementDate);
        rows.push({
          source: "DT",
          city,
          direction,
          barcode,
          status: "done", // pipeline already filtered to items.status === "2"
          date: movementDate,
          movementDate,
          createdOn: str(doc.createdOn),
          soNumber: str(doc.soNumber),
          ticketId: str(doc.ticketId),
          customer: str(doc.customer)?.trim(),
          product: str(doc.product),
          jobType: str(doc.jobType),
        });
      }
      return rows;
    } finally {
      await client.close();
    }
  },
};
