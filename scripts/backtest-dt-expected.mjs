// Does a DT scheduled task actually predict a real movement?
//
// THE QUESTION THIS EXISTS TO ANSWER. The live test asserts the expected rows
// are well-formed — placeable, directional, barcoded. That is not the same as
// correct, and confusing the two is how a completeness check ends up warning
// guards about items that were never going anywhere.
//
// So: take a PAST business day, ask DT what it had scheduled, and compare that
// against what the reconciliation recorded as actually moving. Two numbers come
// out and they mean different things:
//
//   PRECISION  of what DT scheduled, how much really moved. Low precision means
//              the trip-close check will cry wolf — a guard told an item is
//              missing when it was never on the truck.
//   RECALL     of what really moved, how much DT had scheduled. Low recall
//              means the check is blind to most of the day and will miss the
//              gaps it exists to catch.
//
// The not-yet-done filter is DROPPED here on purpose: on a past day every item
// is done, so keeping it would return nothing and the backtest would look
// perfect by returning no predictions at all.
//
//   node scripts/backtest-dt-expected.mjs [YYYY-MM-DD]

import { readFileSync } from "node:fs";
import { connectReadonly } from "./db-connect.mjs";
import { mongoQuery } from "./metabase-mongo.mjs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

const DAY = process.argv[2] ?? "2026-08-20";
const IST = 5.5 * 3600_000;

// The business day is 15:00 → 15:00 IST. scheduledDate is a date marker pinned
// to a fixed hour rather than an event time, so the window is whole days around
// it — the same widening the production pull uses.
const start = new Date(Date.parse(`${DAY}T00:00:00Z`) - IST - 12 * 3600_000);
const end = new Date(Date.parse(`${DAY}T00:00:00Z`) - IST + 36 * 3600_000);

const EXCLUDED = ["New - Buy", "B2B", "Order Transfer"];

const pipeline = [
  {
    $match: {
      scheduledDate: { $gte: { $date: start.toISOString() }, $lt: { $date: end.toISOString() } },
      jobType: { $nin: EXCLUDED },
      email: { $not: { $regex: "cityfurnish\\.com$", $options: "i" } },
    },
  },
  {
    $lookup: {
      from: "orderfromcityfurnishes",
      let: { d: { $toObjectId: "$_id" } },
      pipeline: [
        { $match: { $expr: { $or: [
          { $eq: ["$pickup_deliveryId", "$$d"] },
          { $eq: ["$deliveryId", "$$d"] },
        ] } } },
        { $project: { barcode: 1, status: 1 } },
      ],
      as: "items",
    },
  },
  { $unwind: { path: "$items", preserveNullAndEmptyArrays: false } },
  { $match: { "items.barcode": { $nin: [null, ""] } } },
  { $project: { _id: 0, barcode: "$items.barcode", city: "$city",
                itemStatus: "$items.status", jobType: "$jobType" } },
  { $limit: 20000 },
];

const fold = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "")
  .replace(/[O0]/g, "0").replace(/[I1L]/g, "1").replace(/[S5]/g, "5")
  .replace(/[Z2]/g, "2").replace(/[G6]/g, "6");

console.log(`\nBacktest — DT scheduled tasks against what actually moved, ${DAY}\n`);

const predicted = await mongoQuery("deliveries", pipeline);
const predictedKeys = new Set(predicted.map((r) => fold(r.barcode)).filter(Boolean));
console.log(`  DT scheduled            ${predicted.length} item lines (${predictedKeys.size} distinct barcodes)`);

const c = await connectReadonly();
try {
  // What the reconciliation actually recorded that day, from every source. The
  // canonical spelling is used on both sides — comparing raw spellings would
  // count a confusable character as a miss and understate the hit rate.
  const { rows: actual } = await c.query(
    `select distinct barcode_canonical b, source from source_rows where business_date = $1`, [DAY]
  );
  if (!actual.length) {
    console.log(`\n  No source_rows for ${DAY} — pick a day the reconciler has run.\n`);
    process.exit(0);
  }

  const actualKeys = new Set(actual.map((r) => fold(r.b)).filter(Boolean));
  const bySource = {};
  for (const r of actual) (bySource[r.source] ??= new Set()).add(fold(r.b));

  const hit = [...predictedKeys].filter((k) => actualKeys.has(k));
  const missedByDt = [...actualKeys].filter((k) => !predictedKeys.has(k));

  const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : "n/a");

  console.log(`  actually moved          ${actualKeys.size} distinct barcodes (all sources)\n`);
  console.log(`  PRECISION  ${String(hit.length).padStart(5)} of ${String(predictedKeys.size).padEnd(5)} scheduled really moved   ${pct(hit.length, predictedKeys.size)}`);
  console.log(`             → anything below ~80% means the trip-close check will cry wolf`);
  console.log(`  RECALL     ${String(hit.length).padStart(5)} of ${String(actualKeys.size).padEnd(5)} real movements were scheduled  ${pct(hit.length, actualKeys.size)}`);
  console.log(`             → what DT alone can see; Odoo covers a different slice`);

  console.log(`\n  per source, how much DT predicted:`);
  for (const [src, set] of Object.entries(bySource)) {
    const h = [...set].filter((k) => predictedKeys.has(k)).length;
    console.log(`    ${src.padEnd(9)} ${String(h).padStart(5)} / ${String(set.size).padEnd(5)}  ${pct(h, set.size)}`);
  }

  // A scheduled item that never moved is the false alarm this measures.
  const notMoved = [...predictedKeys].filter((k) => !actualKeys.has(k));
  console.log(`\n  ${notMoved.length} scheduled barcode(s) did not move that day.`);
  console.log(`  ${missedByDt.length} real movement(s) DT had no task for.`);

  const statuses = {};
  for (const r of predicted) statuses[r.itemStatus ?? "null"] = (statuses[r.itemStatus ?? "null"] ?? 0) + 1;
  console.log(`\n  DT item statuses in the prediction: ${JSON.stringify(statuses)}`);
  console.log(`  (2 = done. A high share of NOT-2 on a past day means tasks that never completed.)\n`);
} finally {
  await c.end();
}
