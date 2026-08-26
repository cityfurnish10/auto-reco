// A COMPLETED day still leaves ~30% of tasks with no units attached. Which
// ones, and is it the same ones every day?
//
// This matters because it sets the ceiling. The gate matches on barcodes, so a
// task whose units DT never records is a task the gate can never be checked
// against — no matter when the app pulls. Knowing which task types those are
// turns an unexplained shortfall into a known boundary.
//
//   node scripts/dt-residual-gap.mjs [YYYY-MM-DD]

import { readFileSync } from "node:fs";
import { mongoQuery } from "./metabase-mongo.mjs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

// A day that has fully completed, so nothing is missing merely because it has
// not happened yet.
const DAY = process.argv[2] ?? "2026-08-25";
const prev = new Date(Date.parse(`${DAY}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

const pipeline = [
  { $match: { scheduledDate: {
    $gte: { $date: `${prev}T18:30:00Z` },
    $lt: { $date: `${DAY}T18:30:00Z` },
  } } },
  { $lookup: {
    from: "orderfromcityfurnishes",
    let: { d: { $toObjectId: "$_id" } },
    pipeline: [
      { $match: { $expr: { $or: [
        { $eq: ["$pickup_deliveryId", "$$d"] },   // inward  — confirmed by ops
        { $eq: ["$deliveryId", "$$d"] },          // outward — confirmed by ops
      ] } } },
      { $project: { barcode: 1 } },
    ],
    as: "items",
  } },
  { $group: {
    _id: { sub: "$subCategory", status: "$status" },
    tasks: { $sum: 1 },
    withUnits: { $sum: { $cond: [{ $gt: [{ $size: "$items" }, 0] }, 1, 0] } },
  } },
];

const rows = await mongoQuery("deliveries", pipeline);

// ── By task type ────────────────────────────────────────────────────────
const bySub = new Map();
for (const r of rows) {
  const k = String(r._id?.sub ?? "—");
  const e = bySub.get(k) ?? { tasks: 0, withUnits: 0 };
  e.tasks += r.tasks; e.withUnits += r.withUnits;
  bySub.set(k, e);
}

const pad = (s, n) => String(s ?? "—").slice(0, n).padEnd(n);
console.log(`\nA COMPLETED DAY — ${DAY} — where the missing units are\n`);
console.log(`  ${pad("TASK TYPE", 22)}${"TASKS".padStart(7)}${"WITH".padStart(7)}` +
            `${"NO UNITS".padStart(10)}${"COVERAGE".padStart(10)}`);
console.log("  " + "-".repeat(56));
let tt = 0, tw = 0;
for (const [sub, e] of [...bySub].sort((a, b) => b[1].tasks - a[1].tasks)) {
  tt += e.tasks; tw += e.withUnits;
  console.log(`  ${pad(sub, 22)}${String(e.tasks).padStart(7)}${String(e.withUnits).padStart(7)}` +
              `${String(e.tasks - e.withUnits).padStart(10)}${((e.withUnits / e.tasks) * 100).toFixed(0).padStart(9)}%`);
}
console.log("  " + "-".repeat(56));
console.log(`  ${pad("TOTAL", 22)}${String(tt).padStart(7)}${String(tw).padStart(7)}` +
            `${String(tt - tw).padStart(10)}${((tw / tt) * 100).toFixed(0).padStart(9)}%`);

// ── And by outcome, which is the other candidate explanation ────────────
const byStatus = new Map();
for (const r of rows) {
  const k = String(r._id?.status ?? "—");
  const e = byStatus.get(k) ?? { tasks: 0, withUnits: 0 };
  e.tasks += r.tasks; e.withUnits += r.withUnits;
  byStatus.set(k, e);
}
console.log(`\n  Same day, split by how the task ENDED — a task that was`);
console.log(`  cancelled or never happened has no units for a different reason.\n`);
console.log(`  ${pad("STATUS", 26)}${"TASKS".padStart(7)}${"WITH".padStart(7)}${"COVERAGE".padStart(10)}`);
console.log("  " + "-".repeat(52));
for (const [st, e] of [...byStatus].sort((a, b) => b[1].tasks - a[1].tasks).slice(0, 12)) {
  console.log(`  ${pad(st, 26)}${String(e.tasks).padStart(7)}${String(e.withUnits).padStart(7)}` +
              `${((e.withUnits / e.tasks) * 100).toFixed(0).padStart(9)}%`);
}
console.log("");
