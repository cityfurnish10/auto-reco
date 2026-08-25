// Why is the expected-items list only 1% of a real day?
//
// Measured 2026-08-25: gate_expected_items held 17 rows for the day, while
// Odoo reports roughly 1,451 movements daily. A completeness check running
// against that list would tell a guard almost everything they scanned was
// "not on the list" — noise, and the kind that teaches people to dismiss
// warnings.
//
// Three candidate explanations, and this script separates them rather than
// picking one:
//
//   A  Odoo genuinely has few PENDING pickings — the query takes only
//      'assigned' and 'confirmed', so anything already marked done drops out.
//   B  The 07:00 snapshot is too early — pickings created during the day are
//      never seen. (The same staleness that made the DT pull go live.)
//   C  Planned lines exist but carry no serial, so they are dropped in TS.
//
// A and B look identical in the cached table and completely different here:
// this reports what Odoo RETURNED before any filtering, split by state and by
// serial coverage, and re-runs the same window at the current moment so the
// difference between dawn and now is visible.
//
// Read-only against Odoo (Metabase native query). Needs METABASE_URL,
// METABASE_USERNAME, METABASE_PASSWORD and METABASE_ODOO_DB_ID in .env.local.
//
//   node scripts/expected-coverage.mjs [YYYY-MM-DD]

import { readFileSync } from "node:fs";

// .env.local is not loaded for a bare node script the way it is for Next.
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

const need = ["METABASE_URL", "METABASE_USERNAME", "METABASE_PASSWORD", "METABASE_ODOO_DB_ID"];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`\nMissing from .env.local: ${missing.join(", ")}`);
  console.error("Vercel marks these sensitive, so they cannot be pulled — paste them by hand.\n");
  process.exit(2);
}

const { probeExpectedCoverage } = await import("../lib/gate/expected.ts")
  .catch(async () => import("../lib/gate/expected.js"));

const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
console.log(`\nExpected-items coverage for business date ${date}\n`);

const p = await probeExpectedCoverage(date);
console.log(`  planned lines Odoo returned   ${p.plannedLines}`);
console.log(`  ... carrying a serial          ${p.withSerial}`);
console.log(`  ... dropped, no serial yet     ${p.withoutSerial}`);
console.log(`  coverage                       ${p.coverage === null ? "n/a" : `${Math.round(p.coverage * 100)}%`}`);
console.log("\n  by Odoo state:");
for (const [state, v] of Object.entries(p.byState)) {
  console.log(`    ${state.padEnd(12)} ${String(v.total).padStart(5)} lines, ` +
              `${String(v.withSerial).padStart(5)} with a serial ` +
              `(${v.coverage === null ? "n/a" : `${Math.round(v.coverage * 100)}%`})`);
}

console.log(`
  How to read this:

    plannedLines is LARGE and withoutSerial is large   -> explanation C.
        The lines exist; Odoo has not reserved units against them yet.
        Fix the serial coverage, not the schedule.

    plannedLines is SMALL (tens, not hundreds)          -> explanation A or B.
        Odoo has almost nothing pending for this window. Either the day's
        pickings are created later (B — refresh live, as the DT pull now
        does), or most movements reach 'done' without ever sitting in
        'assigned' long enough to be caught (A — the state filter is wrong
        for what the gate is actually asking).

        Re-run this same command later in the day. If the number climbs
        sharply, it is B.
`);
