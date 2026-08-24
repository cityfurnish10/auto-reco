// Which tables this read-only role can actually SEE ROWS in, and which are
// hidden by row-level security.
//
// Connecting is not the same as being able to read. RLS policies on this
// project are written against auth_is_admin() / auth_city(), which resolve to
// nothing for a plain Postgres login -- so a policy that looks permissive to a
// logged-in admin filters everything out here.

import { readFileSync } from "node:fs";
import pg from "pg";

const url = readFileSync(".env.local", "utf8")
  .match(/DATABASE_READONLY_URL=(.+)/)[1].trim();
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();

const tables = await c.query(`
  select c.relname as t, c.relrowsecurity as rls
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
  order by c.relname`);

for (const r of tables.rows) {
  const n = await c
    .query(`select count(*)::int as n from public."${r.t}"`)
    .catch(() => ({ rows: [{ n: "denied" }] }));
  console.log(`${r.rls ? "RLS " : "open"}  ${String(n.rows[0].n).padStart(6)}  ${r.t}`);
}
await c.end();
