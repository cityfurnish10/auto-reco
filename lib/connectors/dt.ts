// Delivery Tracker connector — MongoDB (Atlas `cityfurnish` DB). Implements
// the aggregation from DB MODEL.md §18: <parent> + orderfromcityfurnishes
// (barcode lines), done-only filtered (§15), direction derived per §14.
//
// ✅ RESOLVED (2026-07-15): DB MODEL.md named the parent collection `tasks`,
// but on the live cluster `tasks` is empty (0 docs) — it was superseded by
// `deliveries` (174k docs) at some point after the doc was written. Verified
// directly: orderfromcityfurnishes.pickup_deliveryId/deliveryId resolve into
// `deliveries` (not tasks/trips/forms/etc.), and `deliveries` carries exactly
// the fields §18 expects (scheduledDate, email, firstName/lastName, jobType,
// ticketNumber, city, category, subCategory, status). The full pipeline
// sourced from `deliveries` returns real done rows for a D-1 window across all
// 5 cities. The source collection is configurable via DT_TASKS_COLLECTION
// (default "deliveries") in case it's renamed again.
//
// Requires: DT_MONGODB_URI (full connection string), DT_MONGODB_DB (default
// "cityfurnish"). Node runtime only (uses the `mongodb` driver).

import { MongoClient } from "mongodb";
import type { Connector, CityTaggedRow } from "./types";
import { normalizeCity } from "./types";
import { dayToUtcWindow, istDayToUtcWindow, usesCalendarDay } from "./ist-window";
import { deriveDtDirection, DT_EXCLUDED_JOB_TYPES } from "./dt-mapping";

const DT_PARENT_COLLECTION = process.env.DT_TASKS_COLLECTION ?? "deliveries";

// Trim so identifiers/text match across sources (Sheets/Guard already trim);
// stray whitespace in a barcode would otherwise be a distinct raw spelling.
function str(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

// Date fields come back from the driver as BSON Date objects. String(date)
// yields an ugly locale string ("Wed Jul 15 2026 …GMT+0530…") — normalize to
// ISO so downstream (engine grouping, variances.date column) gets a clean,
// sortable, parseable value. Strings (already-ISO stored values) pass through.
function dateStr(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

export const dtConnector: Connector = {
  source: "DT",
  label: "Delivery Tracker",
  async pull(runDate: string): Promise<CityTaggedRow[]> {
    const uri = process.env.DT_MONGODB_URI;
    if (!uri) throw new Error("DT not configured (set DT_MONGODB_URI).");

    const dbName = process.env.DT_MONGODB_DB ?? "cityfurnish";
    // WHICH DAY A DELIVERY TASK BELONGS TO — two answers, by date.
    //
    // FROM 13 Sep 2026 the task is placed on the day it was SCHEDULED for
    // (owner's decision, 16 Sep 2026). A delivery scheduled for the 14th is the
    // 14th's movement even when the agent closes it at half past midnight, and
    // that is also the day the goods crossed the gate — so the Tracker now
    // lines up with the guard rather than with its own paperwork clock.
    // scheduledDate is a DATE, not an event time (measured July 2026: 6,659 of
    // 6,753 values sit at exactly 10:00 IST), which is exactly why it can carry
    // a calendar day and could never have carried a 15:00 one.
    //
    // BEFORE THAT the old rule stands, unchanged, so re-running an older date
    // reproduces what it meant: the 15:00-to-15:00 day, cut on items.updatedAt
    // — the real completion timestamp, with its realistic evening peak.
    //
    // The two-stage filter exists because of indexes, not taste:
    // orderfromcityfurnishes.updatedAt is NOT indexed (333k docs → collection
    // scan), while deliveries.scheduledDate IS. So scheduledDate stays as the
    // cheap bounding pre-scan either way, widened on the old path to cover the
    // scheduled→completed lag (measured: 1,110 same-day, 542 +1d, 24 +2d, 4
    // beyond — a 7-day lookback covers 99.9%).
    const byScheduledDate = usesCalendarDay(runDate);
    const { startUtc, endUtcExclusive } = dayToUtcWindow(runDate);
    // On the new path the pre-scan IS the filter, so it is the day itself.
    const schedule = byScheduledDate ? istDayToUtcWindow(runDate) : null;
    const SCAN_LOOKBACK_DAYS = 7;
    const scanStart = schedule
      ? new Date(schedule.startUtc)
      : new Date(Date.parse(startUtc) - SCAN_LOOKBACK_DAYS * 86_400_000);
    const scanEnd = schedule
      ? new Date(schedule.endUtcExclusive)
      : new Date(Date.parse(endUtcExclusive) + 86_400_000);

    const client = new MongoClient(uri);
    try {
      await client.connect();
      const db = client.db(dbName);

      // Mirrors DB MODEL.md §18 (users/agent join dropped — agentName isn't
      // consumed by SourceRow; add back if source_rows.raw ever captures it).
      const pipeline = [
        {
          $match: {
            // Indexed. On the calendar path this is THE filter — the scheduled
            // day is the answer. On the old path it is a bounding pre-scan and
            // the precise cut happens on items.updatedAt below.
            scheduledDate: { $gte: scanStart, $lt: scanEnd },
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
        // The old rule's cut: when the movement actually completed. Dropped on
        // the calendar path, where the scheduled day has already decided it —
        // keeping it there would re-impose the very boundary this replaced and
        // throw away every task closed after midnight.
        ...(byScheduledDate
          ? []
          : [{
              $match: {
                "items.updatedAt": {
                  $gte: new Date(startUtc),
                  $lt: new Date(endUtcExclusive),
                },
              },
            }]),
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
      const cursor = db.collection(DT_PARENT_COLLECTION).aggregate(pipeline);
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

        const movementDate = dateStr(doc.movementDate);
        rows.push({
          source: "DT",
          city,
          direction,
          barcode,
          status: "done", // pipeline already filtered to items.status === "2"
          // `date` = the IST business date this row was reconciled for. The
          // rows are windowed on scheduledDate == runDate, so runDate IS the
          // business date; items.updatedAt (the completion timestamp, which can
          // land on the next calendar day) is kept in movementDate. Uniform
          // with every other connector — all emit runDate here (Section 3).
          date: runDate,
          movementDate,
          createdOn: dateStr(doc.createdOn),
          soNumber: str(doc.soNumber),
          ticketId: str(doc.ticketId),
          customer: str(doc.customer),
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
