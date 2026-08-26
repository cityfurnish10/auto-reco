// Does DT's picture of a day fill in as the day goes on?
//
// THE HYPOTHESIS, from operations: trucks are assigned and items attached right
// up to the moment of dispatch, so a day still in progress necessarily looks
// thin. If that is right, a completed day should be markedly better covered
// than today — and if it is wrong, the gap is structural and no amount of
// pulling later will fix it.
//
// Coverage here means: of the tasks DT scheduled for that day, how many have
// their physical units attached. Those are the only ones a gate can match a
// scan against.
//
//   node scripts/dt-coverage-by-day.mjs

import { readFileSync } from "node:fs";
import { mongoQuery } from "./metabase-mongo.mjs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

const IST_OFFSET = "18:30:00Z";     // 00:00 IST expressed in UTC on the prior day
const days = process.argv.slice(2);
if (!days.length) {
  // The last five days plus today, so a trend is visible rather than a pair.
  const today = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86_400_000);
    days.push(d.toISOString().slice(0, 10));
  }
}

const pipelineFor = (day) => {
  const prev = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return [
    { $match: { scheduledDate: {
      $gte: { $date: `${prev}T${IST_OFFSET}` },
      $lt: { $date: `${day}T${IST_OFFSET}` },
    } } },
    { $lookup: {
      from: "orderfromcityfurnishes",
      let: { d: { $toObjectId: "$_id" } },
      pipeline: [
        { $match: { $expr: { $or: [
          { $eq: ["$pickup_deliveryId", "$$d"] },
          { $eq: ["$deliveryId", "$$d"] },
        ] } } },
        { $project: { barcode: 1 } },
      ],
      as: "items",
    } },
    { $group: {
      _id: null,
      tasks: { $sum: 1 },
      withUnits: { $sum: { $cond: [{ $gt: [{ $size: "$items" }, 0] }, 1, 0] } },
      units: { $sum: { $size: "$items" } },
    } },
  ];
};

console.log("\nDT COVERAGE BY DAY — how much of a day's plan carries its units\n");
console.log(`  ${"DAY".padEnd(12)} ${"TASKS".padStart(6)} ${"WITH UNITS".padStart(11)} ` +
            `${"SHARE".padStart(7)} ${"UNITS".padStart(7)}`);
console.log("  " + "-".repeat(48));

for (const day of days) {
  try {
    const rows = await mongoQuery("deliveries", pipelineFor(day));
    const r = rows[0];
    if (!r) { console.log(`  ${day.padEnd(12)} ${"no data".padStart(6)}`); continue; }
    const share = r.tasks ? (r.withUnits / r.tasks) * 100 : 0;
    console.log(`  ${day.padEnd(12)} ${String(r.tasks).padStart(6)} ` +
                `${String(r.withUnits).padStart(11)} ${share.toFixed(0).padStart(6)}% ` +
                `${String(r.units).padStart(7)}`);
  } catch (e) {
    console.log(`  ${day.padEnd(12)} failed: ${String(e.message).slice(0, 50)}`);
  }
}
console.log("\n  A rising share on older days supports the operations view — that\n" +
            "  assignment happens late and a day in progress is thin by nature.\n" +
            "  A flat share means the gap is structural, and pulling later will\n" +
            "  not close it.\n");
