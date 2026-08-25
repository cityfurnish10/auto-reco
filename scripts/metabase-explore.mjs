// Explore a Metabase database's structure.
//
// Written to answer the DT question: which field on a delivery holds the
// delivery agent, and which holds the vehicle. Those two have never been read
// by this codebase — dt.ts drops the agent join deliberately — and the gate
// app needs them to offer a guard a dropdown instead of a blank box.
//
// Works for the Odoo replica too, which is how METABASE_ODOO_DB_ID gets
// confirmed rather than assumed.
//
// Read-only: it reads Metabase's own metadata, and optionally one sample row.
//
//   node scripts/metabase-explore.mjs                 list databases
//   node scripts/metabase-explore.mjs <dbId>          list that database's tables
//   node scripts/metabase-explore.mjs <dbId> <table>  list that table's fields

import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

const BASE = (process.env.METABASE_URL ?? "").replace(/\/+$/, "");
const KEY = process.env.METABASE_API_KEY;
if (!BASE || !KEY) { console.error("METABASE_URL / METABASE_API_KEY missing from .env.local"); process.exit(2); }

async function api(path) {
  const r = await fetch(`${BASE}${path}`, { headers: { "x-api-key": KEY } });
  if (r.status === 401) {
    console.error(`\n401 Unauthenticated.\n\nThe URL is right — /api/health answers — so the key itself is being` +
                  ` rejected.\nEither it was mistyped, or it has been revoked, or it belongs to a` +
                  ` different\nMetabase instance. Generate a fresh one under Admin settings →` +
                  ` Authentication →\nAPI keys and copy it whole.\n`);
    process.exit(3);
  }
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} on ${path}`);
  return r.json();
}

const [dbArg, tableArg] = process.argv.slice(2);

/* ── no argument: what can this key see? ─────────────────────────────── */
if (!dbArg) {
  const res = await api("/api/database");
  const dbs = Array.isArray(res) ? res : (res.data ?? []);
  console.log(`\n${dbs.length} database(s) visible to this key\n`);
  for (const d of dbs) console.log(`  id ${String(d.id).padEnd(4)} ${String(d.name).padEnd(34)} ${d.engine}`);
  console.log("\nNext: node scripts/metabase-explore.mjs <dbId>\n");
  process.exit(0);
}

/* ── a database: what tables (or Mongo collections) does it hold? ────── */
const meta = await api(`/api/database/${dbArg}/metadata`);
const tables = meta.tables ?? [];

if (!tableArg) {
  console.log(`\n${meta.name} (${meta.engine}) — ${tables.length} table(s)\n`);
  for (const t of tables.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${String(t.name).padEnd(40)} ${t.fields?.length ?? "?"} fields`);
  }
  console.log("\nNext: node scripts/metabase-explore.mjs <dbId> <tableName>\n");
  process.exit(0);
}

/* ── a table: what fields, and which look like an agent or a vehicle? ── */
const t = tables.find((x) => x.name.toLowerCase() === tableArg.toLowerCase());
if (!t) {
  console.error(`No table named "${tableArg}". Run without a table name to list them.`);
  process.exit(4);
}

const fields = (t.fields ?? []).sort((a, b) => a.name.localeCompare(b.name));
console.log(`\n${meta.name} · ${t.name} — ${fields.length} fields\n`);
for (const f of fields) {
  console.log(`  ${String(f.name).padEnd(34)} ${String(f.base_type ?? "").replace("type/", "").padEnd(14)}` +
              `${f.semantic_type ? String(f.semantic_type).replace("type/", "") : ""}`);
}

// The whole reason this script exists.
const hits = (re) => fields.filter((f) => re.test(f.name)).map((f) => f.name);
console.log("\n  looks like a DELIVERY AGENT :", hits(/agent|driver|executive|associate|assign|rider|delivery.*name/i).join(", ") || "nothing obvious");
console.log("  looks like a VEHICLE        :", hits(/vehicle|truck|van|reg.*no|lorry/i).join(", ") || "nothing obvious");
console.log("  looks like an ADDRESS       :", hits(/address|locality|pincode|city|area/i).join(", ") || "nothing obvious");
console.log("  looks like a SCHEDULE DATE  :", hits(/schedul|date|slot|planned/i).join(", ") || "nothing obvious");
console.log("");
