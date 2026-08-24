// One place that opens the Delivery Tracker (MongoDB) connection for local
// tooling — the DT counterpart of db-connect.mjs.
//
// Reads DT_MONGODB_URI from .env.local, which is gitignored. Populate it with
//   npx vercel env pull
// or by copying the value out of the Vercel project settings.
//
// Everything that uses this is READ-ONLY. DT is a production system owned by
// operations; nothing in this repo writes to it.

import { readFileSync } from "node:fs";
import { MongoClient } from "mongodb";

export function dtEnv() {
  const txt = readFileSync(".env.local", "utf8");
  const pick = (k, fallback) => {
    const m = txt.match(new RegExp(`^\\s*${k}=(.+)$`, "m"));
    return m ? m[1].trim().replace(/^"|"$/g, "") : fallback;
  };
  const uri = pick("DT_MONGODB_URI");
  if (!uri) throw new Error("DT_MONGODB_URI is not set in .env.local");
  return {
    uri,
    db: pick("DT_MONGODB_DB", "cityfurnish"),
    collection: pick("DT_TASKS_COLLECTION", "deliveries"),
  };
}

/** Connected client plus the resolved database handle. Caller closes. */
export async function connectDt() {
  const env = dtEnv();
  const client = new MongoClient(env.uri);
  await client.connect();
  return { client, db: client.db(env.db), collection: env.collection };
}
