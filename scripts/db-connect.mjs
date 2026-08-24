// One place that opens the read-only connection.
//
// Uses the SESSION POOLER rather than Supabase's direct host. The direct
// endpoint publishes only an IPv6 address unless the project buys the IPv4
// add-on, and an intermittent IPv6 route produced two successful connections
// followed by EHOSTUNREACH -- which looked like a credentials problem and was
// not. The pooler has IPv4 and behaves the same every time.
//
// The pooler also wants the username as `role.project-ref`, which is already
// baked into the URL in .env.local.

import { readFileSync } from "node:fs";
import pg from "pg";

export function readonlyUrl() {
  const m = readFileSync(".env.local", "utf8").match(/^\s*DATABASE_READONLY_URL=(.+)$/m);
  if (!m) throw new Error("DATABASE_READONLY_URL is not set in .env.local");
  return m[1].trim();
}

export async function connectReadonly(url = readonlyUrl()) {
  const client = new pg.Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  return client;
}
