// Run a MongoDB aggregation against a Metabase-connected Mongo database.
//
// Metabase's native-query API takes SQL for relational engines and a MongoDB
// aggregation PIPELINE for Mongo ones, plus the collection name — a different
// shape from runNativeSql in lib/connectors/metabase.ts, which only ever needed
// SQL for Odoo.
//
// This exists so the Delivery Tracker can be read through the credential the
// project already has, rather than provisioning a separate MongoDB login. DT is
// where the trucks, the delivery agents and the delivery addresses live.
//
// Read-only by construction: an aggregation pipeline cannot write.
//
//   node scripts/metabase-mongo.mjs <collection> '<pipeline JSON>'
//
// e.g. node scripts/metabase-mongo.mjs trips '[{"$limit":3}]'

import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

const BASE = (process.env.METABASE_URL ?? "").replace(/\/+$/, "");
const KEY = process.env.METABASE_API_KEY;
const DB = Number(process.env.METABASE_DT_DB_ID ?? 6);

export async function mongoQuery(collection, pipeline, dbId = DB) {
  const r = await fetch(`${BASE}/api/dataset`, {
    method: "POST",
    headers: { "x-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      database: dbId,
      type: "native",
      native: { collection, query: JSON.stringify(pipeline) },
    }),
  });
  const j = await r.json();
  if (j.status === "failed" || j.error) {
    throw new Error(j.error ?? j.error_type ?? "query failed");
  }
  const cols = (j.data?.cols ?? []).map((c) => c.name);
  return (j.data?.rows ?? []).map((row) =>
    Object.fromEntries(cols.map((c, i) => [c, row[i]]))
  );
}

// pathToFileURL, not string concatenation: this repo lives under a path with
// spaces in it, so `file://${argv[1]}` never matches the percent-encoded
// import.meta.url and the whole block silently does nothing.
const { pathToFileURL } = await import("node:url");
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [collection, raw] = process.argv.slice(2);
  if (!collection) { console.error("usage: metabase-mongo.mjs <collection> '<pipeline JSON>'"); process.exit(2); }
  const rows = await mongoQuery(collection, JSON.parse(raw ?? "[{\"$limit\":3}]"));
  console.log(JSON.stringify(rows, null, 2).slice(0, 6000));
  console.log(`\n${rows.length} row(s)`);
}
