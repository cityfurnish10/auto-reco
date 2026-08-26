// Repair tasks that have units attached.
//
// Operations expect a repair to move nothing — it is fixed where it stands. So
// every ticket listed here is an anomaly worth someone looking at: either the
// item really did travel, or DT has units attached to a task that never
// carried any.
//
// It matters for the gate because a repair that DOES move an item is a
// movement the guard will see and the reconciliation must account for.
//
//   node scripts/dt-repair-with-units.mjs [YYYY-MM-DD]

import { readFileSync } from "node:fs";
import { mongoQuery } from "./metabase-mongo.mjs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

const DAY = process.argv[2] ?? "2026-08-25";
const prev = new Date(Date.parse(`${DAY}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

const rows = await mongoQuery("deliveries", [
  { $match: {
    scheduledDate: { $gte: { $date: `${prev}T18:30:00Z` }, $lt: { $date: `${DAY}T18:30:00Z` } },
    subCategory: "Repair",
  } },
  { $lookup: {
    from: "orderfromcityfurnishes",
    let: { d: { $toObjectId: "$_id" } },
    pipeline: [
      { $match: { $expr: { $or: [
        // pickup_deliveryId is the INWARD leg, deliveryId the OUTWARD one —
        // confirmed by operations.
        { $eq: ["$pickup_deliveryId", "$$d"] },
        { $eq: ["$deliveryId", "$$d"] },
      ] } } },
      { $project: { _id: 0, barcode: 1, status: 1, Product_name: 1,
                    leg: { $cond: [{ $gt: [{ $ifNull: ["$deliveryId", null] }, null] }, "OUT", "IN"] } } },
    ],
    as: "items",
  } },
  { $match: { "items.0": { $exists: true } } },
  { $project: {
    _id: 0, ticketNumber: 1, city: 1, status: 1, subStatus: 1, jobType: 1,
    customer: { $trim: { input: { $concat: [
      { $ifNull: ["$firstName", ""] }, " ", { $ifNull: ["$lastName", ""] },
    ] } } },
    items: 1,
  } },
  { $limit: 200 },
]);

console.log(`\nREPAIR TASKS WITH UNITS ATTACHED — ${DAY}`);
console.log(`${rows.length} ticket(s). Operations expect a repair to move nothing.\n`);

const pad = (s, n) => String(s ?? "—").slice(0, n).padEnd(n);
const byCity = new Map();
for (const r of rows) byCity.set(r.city ?? "—", (byCity.get(r.city ?? "—") ?? 0) + 1);

console.log("  by city: " + [...byCity].map(([c, n]) => `${c} ${n}`).join(" · ") + "\n");
console.log(`  ${pad("TICKET", 10)}${pad("CITY", 12)}${pad("STATUS", 20)}${pad("CUSTOMER", 22)}UNITS`);
console.log("  " + "-".repeat(74));
for (const r of rows) {
  console.log(`  ${pad(r.ticketNumber, 10)}${pad(r.city, 12)}${pad(r.status, 20)}` +
              `${pad(r.customer, 22)}${r.items.length}`);
  for (const i of r.items) {
    console.log(`${" ".repeat(12)}${pad(i.leg, 5)}${pad(i.barcode, 18)}` +
                `${pad("status " + i.status, 11)}${String(i.Product_name ?? "").slice(0, 34)}`);
  }
}
console.log("");
