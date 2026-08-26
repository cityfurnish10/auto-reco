// What the Delivery Tracker says is due at a gate today.
//
// THE SECOND SOURCE FOR THE EXPECTED LIST, alongside Odoo. They answer
// different halves of the same question and neither is sufficient:
//
//   Odoo  what the item IS — the picking, the serial, the product, the order.
//   DT    who it is FOR and where it is going — customer, ticket, full
//         delivery address, job type.
//
// That difference is the whole reason this file exists. When a truck closes
// short, "FUMY5U23080048 missing" sends a guard to a supervisor;
// "Queen Bed, for A Sharma, 44 Golf Course Road" sends them to a pallet.
//
// SCHEDULED TASKS CARRY BARCODES, which is what makes this possible and was not
// obvious — verified 2026-08-26 against ticket 1174052, status "Scheduled",
// with two barcoded units attached and item status "1" (not yet moved; "2" is
// done). DT therefore knows which physical units are due, not merely which
// orders.
//
// Read through Metabase, like the fleet: the project already holds that
// credential, an aggregation pipeline cannot write, and no production Mongo
// connection string has to leave Vercel.

import { runMongoPipeline, metabaseConfigured } from "../connectors/metabase";
import { normalizeCity } from "../connectors/types";
import { deriveDtDirection, DT_EXCLUDED_JOB_TYPES } from "../connectors/dt-mapping";
import { canonicalize } from "../engine/barcode";
import { businessDayToUtcWindow } from "../connectors/ist-window";
import type { City } from "../sample-data";
import type { Direction } from "../engine/types";

/** Which Metabase database is DT. Shared with the fleet lookup. */
const dtDb = (): number => Number(process.env.METABASE_DT_DB_ID ?? 6);

/** On a path a guard waits on, so it is bounded. */
const TIMEOUT_MS = 10_000;

export interface DtExpectedRow {
  city: City;
  direction: Direction;
  barcode: string;
  product: string | null;
  soNumber: string | null;
  ticketId: string | null;
  customer: string | null;
  deliveryAddress: string | null;
  orderDetails: string | null;
}

/**
 * Flatten DT's nested address object into one line a guard can read.
 *
 * Three things have to be thrown away, all real in this data:
 *
 *   A DANGLING LANDMARK — somebody typed "Near " or "Opposite" and stopped.
 *     Left in, the line reads "12 MG Road, Near", which looks like the app
 *     truncated the address rather than the entry being incomplete.
 *   A REPEAT — cf_address_2 is frequently cf_address_1 again in another case.
 *   AN ECHOED CITY — cf_address_1 usually already ends with the city, state
 *     and pincode, so appending cf_city and cf_pincode produced
 *     "…Goregaon East, Mumbai, Maharashtra 400063, Mumbai, 400063". Correct
 *     data, unreadable line, and it makes the app look careless at exactly the
 *     moment a guard is relying on it.
 */
export function formatAddress(a: unknown): string | null {
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  const clean = (v: unknown) => {
    const t = String(v ?? "").trim();
    return !t || t.toLowerCase() === "null" ? "" : t;
  };

  const DANGLING = /^(near|opp|opposite|behind|beside|next to|besides|infront of|in front of)\.?$/i;
  const kept: string[] = [];
  const push = (raw: string, skipIfPresent = false) => {
    const v = raw.trim().replace(/[,\s]+$/, "");
    if (v.length < 3 || DANGLING.test(v)) return;
    const line = kept.join(", ").toLowerCase();
    // A repeat of something already said, or a city/pincode the street line
    // has already spelled out.
    if (line.includes(v.toLowerCase())) return;
    if (skipIfPresent && line.includes(v.toLowerCase())) return;
    kept.push(v);
  };

  push(clean(o.cf_address_1));
  push(clean(o.cf_address_2));
  push(clean(o.cf_area));
  // These two are appended ONLY when the street lines have not already said
  // them, which is the common case in this data rather than the exception.
  push(clean(o.cf_city), true);
  push(clean(o.cf_pincode), true);

  const line = kept.join(", ").replace(/\s+/g, " ").trim();
  return line.length >= 6 ? line.slice(0, 300) : null;
}

/**
 * The pipeline. Separate so a test can assert its shape without a network.
 *
 * `scheduledDate` is a date marker pinned to a fixed hour rather than an event
 * time — measured elsewhere in this repo as 10:00 IST on almost every row — so
 * it is used as a day filter and never as a clock.
 */
export function dtExpectedPipeline(from: Date, to: Date): unknown[] {
  return [
    {
      $match: {
        scheduledDate: { $gte: { $date: from.toISOString() }, $lt: { $date: to.toISOString() } },
        // Internal movements are not customer deliveries and the reconciler
        // excludes them; the gate should not warn about them either.
        jobType: { $nin: DT_EXCLUDED_JOB_TYPES },
        email: { $not: { $regex: "cityfurnish\\.com$", $options: "i" } },
      },
    },
    {
      // The barcodes live on the item rows, joined by either of two references
      // depending on whether the task is a delivery or a pickup.
      $lookup: {
        from: "orderfromcityfurnishes",
        let: { d: { $toObjectId: "$_id" } },
        pipeline: [
          { $match: { $expr: { $or: [
            { $eq: ["$pickup_deliveryId", "$$d"] },
            { $eq: ["$deliveryId", "$$d"] },
          ] } } },
          // status "2" is DONE. What the gate wants to know is what is still
          // to move, so a unit already marked complete is not expected at the
          // gate any more.
          { $match: { status: { $ne: "2" } } },
          { $project: { barcode: 1, Product_name: 1, Sale_Order: 1, client_Status: 1,
                        deliveryId: 1, pickup_deliveryId: 1 } },
        ],
        as: "items",
      },
    },
    { $unwind: { path: "$items", preserveNullAndEmptyArrays: false } },
    { $match: { "items.barcode": { $nin: [null, ""] } } },
    {
      $project: {
        _id: 0,
        barcode: "$items.barcode",
        product: "$items.Product_name",
        soNumber: "$items.Sale_Order",
        ticketId: "$ticketNumber",
        customer: { $trim: { input: { $concat: [
          { $ifNull: ["$firstName", ""] }, " ", { $ifNull: ["$lastName", ""] },
        ] } } },
        address: "$address",
        city: "$city",
        jobType: "$jobType",
        category: "$category",
        subCategory: "$subCategory",
        movement: "$movement",
        clientStatus: "$items.client_Status",
        hasDeliveryId: { $cond: [{ $gt: [{ $ifNull: ["$items.deliveryId", null] }, null] }, true, false] },
        hasPickupDeliveryId: { $cond: [{ $gt: [{ $ifNull: ["$items.pickup_deliveryId", null] }, null] }, true, false] },
      },
    },
    { $limit: 8000 },
  ];
}

export interface DtExpectedPull {
  rows: DtExpectedRow[];
  /** Lines dropped, and why — reported rather than silently discarded, because
   *  each is a movement the gate will not be able to warn about. */
  skipped: { unknownCity: number; ambiguousDirection: number };
}

/**
 * Read DT's scheduled tasks for a business day.
 *
 * Never throws. The expected list already works from Odoo alone; DT enriches
 * it, and a bad minute at DT must cost the enrichment rather than the list.
 */
export async function fetchDtExpected(businessDate: string): Promise<DtExpectedPull> {
  const empty: DtExpectedPull = { rows: [], skipped: { unknownCity: 0, ambiguousDirection: 0 } };
  if (!metabaseConfigured()) return empty;

  const { startUtc, endUtcExclusive } = businessDayToUtcWindow(businessDate);
  // scheduledDate sits at a fixed hour rather than the movement's real time, so
  // the window is widened to whole days around the business day — cutting it at
  // 15:00 would push a whole day's tasks into the wrong bucket.
  const from = new Date(Date.parse(startUtc) - 12 * 3600_000);
  const to = new Date(Date.parse(endUtcExclusive) + 12 * 3600_000);

  try {
    const table = await runMongoPipeline(dtDb(), "deliveries",
      dtExpectedPipeline(from, to), TIMEOUT_MS);

    const rows: DtExpectedRow[] = [];
    const skipped = { unknownCity: 0, ambiguousDirection: 0 };

    for (const r of table.rows) {
      // A CITY IS A WAREHOUSE. Chennai is served from the Bangalore building,
      // so a Chennai task belongs to the Bangalore gate — see CATCHMENTS in
      // connectors/types.ts, which used to drop these entirely.
      const city = normalizeCity(r.city);
      if (!city) { skipped.unknownCity++; continue; }

      const direction = deriveDtDirection({
        category: r.category as string | undefined,
        jobType: r.jobType as string | undefined,
        subCategory: r.subCategory as string | undefined,
        movement: r.movement as string | undefined,
        clientStatus: r.clientStatus as string | undefined,
        hasDeliveryId: !!r.hasDeliveryId,
        hasPickupDeliveryId: !!r.hasPickupDeliveryId,
      });
      // Ambiguous is SKIPPED, never guessed. Warning a guard that an item is
      // missing from the wrong direction is worse than not warning at all.
      if (!direction) { skipped.ambiguousDirection++; continue; }

      const barcode = String(r.barcode ?? "").trim();
      if (!barcode) continue;

      const customer = String(r.customer ?? "").replace(/\s+/g, " ").trim();
      rows.push({
        city, direction, barcode,
        product: (r.product as string) || null,
        soNumber: (r.soNumber as string) || null,
        ticketId: (r.ticketId as string) || null,
        customer: customer || null,
        deliveryAddress: formatAddress(r.address),
        orderDetails: (r.jobType as string) || null,
      });
    }
    return { rows, skipped };
  } catch {
    return empty;
  }
}

/** The row shape the expected-items table stores. Kept here so the merge in
 *  expected.ts has one definition to work against. */
export function toExpectedRow(r: DtExpectedRow, businessDate: string) {
  return {
    city: r.city,
    business_date: businessDate,
    direction: r.direction,
    barcode: r.barcode,
    barcode_canon: canonicalize(r.barcode),
    product: r.product,
    so_number: r.soNumber,
    ticket_id: r.ticketId,
    customer: r.customer,
    picking_ref: null as string | null,
    job_type: r.orderDetails,
    delivery_address: r.deliveryAddress,
    order_details: r.orderDetails,
    planned_by: "DT" as const,
  };
}
