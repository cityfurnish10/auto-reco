// What fields does a Delivery Tracker delivery actually carry?
//
// Written to answer one question: which field holds the DELIVERY AGENT and
// which holds the VEHICLE, so the gate app can offer them as a dropdown at the
// start of a trip instead of asking a guard to type them.
//
// Read-only. Prints field names and one masked sample value each.
//
//   node scripts/dt-fields.mjs

import { connectDt } from "./dt-connect.mjs";

const LIMIT = 300;

/** Never print a whole customer record to a terminal. */
function preview(v) {
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === "object") return JSON.stringify(v).slice(0, 90);
  return String(v).slice(0, 60);
}

const { client, db, collection } = await connectDt();
try {
  const names = (await db.listCollections().toArray()).map((c) => c.name).sort();
  console.log("COLLECTIONS\n  " + names.join(", "));

  const recent = await db.collection(collection)
    .find({}).sort({ _id: -1 }).limit(LIMIT).toArray();

  console.log(`\n${collection.toUpperCase()} — fields across ${recent.length} most recent docs`);
  const freq = new Map();
  for (const doc of recent) for (const k of Object.keys(doc)) freq.set(k, (freq.get(k) ?? 0) + 1);
  for (const [k, n] of [...freq].sort((a, b) => b[1] - a[1])) {
    const sample = recent.find((d) => d[k] != null && d[k] !== "")?.[k];
    console.log(`  ${String(n).padStart(3)}/${recent.length}  ${k.padEnd(30)} ${preview(sample)}`);
  }
} finally {
  await client.close();
}
