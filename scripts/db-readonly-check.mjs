// Prove the read-only login works, and prove it cannot write.
//
// The second half matters more than the first. A connection that reads is easy
// to confirm by accident; a connection that CANNOT WRITE has to be tested by
// trying, because the whole point of the role is the thing it must refuse.
//
//   node scripts/db-readonly-check.mjs

import { readFileSync } from "node:fs";
import pg from "pg";

// Read .env.local directly — this script runs outside Next, which is what
// normally loads it.
function envLocal(key) {
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && m[1] === key) return m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* no file yet */ }
  return process.env[key];
}

const url = envLocal("DATABASE_READONLY_URL");
if (!url) {
  console.error("DATABASE_READONLY_URL is not set in .env.local.");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);

try {
  await client.connect();
  ok("connected");

  const who = await client.query("select current_user, current_database()");
  ok(`as ${who.rows[0].current_user} on ${who.rows[0].current_database}`);

  const tables = await client.query(
    `select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`
  );
  ok(`can see ${tables.rows.length} tables`);
  const gate = tables.rows.map((r) => r.table_name).filter((t) => /^(gate_|guard_)/.test(t));
  ok(`gate tables: ${gate.join(", ") || "none yet"}`);

  // A real read, against a table this project actually depends on.
  const guards = await client.query(
    `select count(*)::int as n from guard_profiles where status = 'active'`
  ).catch(() => ({ rows: [{ n: "unreadable" }] }));
  ok(`active guard profiles: ${guards.rows[0].n}`);

  // THE IMPORTANT TEST. This must fail. If it succeeds the role is not
  // read-only and should be dropped immediately.
  try {
    await client.query(`create table if not exists _claude_write_probe (x int)`);
    bad("WRITE SUCCEEDED — the role is NOT read-only. Drop it and re-run the SQL.");
    process.exitCode = 1;
  } catch (e) {
    ok(`writes refused (${String(e.message).split("\n")[0]})`);
  }

  // And the two things it must not be able to look at.
  for (const [label, sql] of [
    ["auth.users", "select 1 from auth.users limit 1"],
    ["vault secrets", "select 1 from vault.decrypted_secrets limit 1"],
  ]) {
    try {
      await client.query(sql);
      bad(`${label} IS READABLE — tighten the grants.`);
      process.exitCode = 1;
    } catch {
      ok(`${label} not readable`);
    }
  }
} catch (e) {
  bad(`could not connect: ${e.message}`);
  console.log(
    "\n  If this says ENOTFOUND or a timeout, the project has no direct IPv4.\n" +
    "  Use the Session pooler string from Supabase → Connect instead, swapping\n" +
    '  "postgres." for "claude_readonly." and keeping the same password.'
  );
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
