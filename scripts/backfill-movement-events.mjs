// Backfill the movement ledger (migration 0015) for the dates source_rows still
// holds — at most 7 days, and in practice ~6.
//
// READ THIS BEFORE RUNNING IT.
//
// This is a RECONSTRUCTION, not a recording. It re-runs the engine, and the
// engine re-reads the LIVE sources — so a six-day-old date returns what is true
// about that night NOW: Odoo postings added since, DT statuses changed, ops
// sheet rows edited. Some backfilled days will legitimately show CLEAN for
// units that genuinely were a problem on the night. Every row it writes carries
// backfilled = TRUE so the ledger cannot quietly overstate historical accuracy.
//
// It writes ONLY movement_events. Deliberately NOT:
//   * saveSourceRows            — plain-inserts, would double the raw feed for
//                                 those dates and skew the coverage probes;
//   * resolveStaleOpenVariances — DELETEs superseded rows and rewrites open
//                                 ones (bucket, priority, note) that a manager
//                                 may be part-way through triaging;
//   * upsertVariances           — the variance rows for these dates are already
//                                 correct and human-annotated;
//   * saveCityStats             — would overwrite the day's leaderboard numbers
//                                 with today's re-pull.
//
// Nothing older than the source_rows window can be recovered at all: the
// OCR-orphan fold and the fragment drop are not replayable from stored raw rows
// (see 0013's header), and the ladder's Odoo timing composite is per-city logic
// rather than a query. For those dates the ledger simply has no history.
//
// Run:  node scripts/backfill-movement-events.mjs [--days 6] [--dry]

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf-8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const e = t.indexOf("=");
  if (e < 0) continue;
  let v = t.slice(e + 1).trim();
  if (v.startsWith('"') && v.endsWith('"')) {
    try {
      v = JSON.parse(v);
    } catch {
      v = v.slice(1, -1);
    }
  }
  env[t.slice(0, e).trim()] = v;
}
for (const [k, v] of Object.entries(env)) process.env[k] ??= v;

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const daysArg = argv.indexOf("--days");
const maxDays = daysArg >= 0 ? Number(argv[daysArg + 1]) : 7;

// The engine and persist layer are TypeScript; run this through vite-node:
//   npx vite-node scripts/backfill-movement-events.mjs
const { pullAll } = await import("../lib/connectors/index.ts");
const { runAllCities } = await import("../lib/engine/run.ts");
const { upsertMovementEvents, loadRecentFloorBarcodes } = await import("../lib/db/persist.ts");

// Which dates are actually reconstructible? Ask the data, not the 7-day
// constant — the prune runs at the end of each reconcile so the real floor
// drifts, and a constant would promise a day that is already gone.
//
// Probed one candidate date at a time with a HEAD count, NOT by selecting rows
// and reducing to distinct: source_rows holds ~12k rows per day, so any capped
// select ordered by date returns nothing but the newest day and this script
// would quietly backfill one date and report success.
const today = new Date().toISOString().slice(0, 10);
const shift = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const dates = [];
for (let back = 0; back <= maxDays; back++) {
  const date = shift(today, -back);
  const { count, error } = await db
    .from("source_rows")
    .select("id", { count: "exact", head: true })
    .eq("business_date", date);
  if (error) {
    console.error("could not read source_rows:", error.message);
    process.exit(1);
  }
  if ((count ?? 0) > 0) dates.push({ date, rows: count });
}
dates.reverse(); // oldest first, so a partial run leaves the newest days done

if (dates.length === 0) {
  console.log("no retained source_rows — nothing is reconstructible.");
  process.exit(0);
}
console.log(`reconstructible dates (${dates.length}):`);
for (const d of dates) console.log(`  ${d.date}  ${d.rows} source rows`);
if (dry) {
  console.log("--dry: stopping before any write.");
  process.exit(0);
}

let total = 0;
for (const { date } of dates) {
  // Reuse the date's own latest run id so the ledger points at the run that
  // produced the variances, rather than inventing one.
  const { data: runs } = await db
    .from("reconciliation_runs")
    .select("id")
    .eq("business_date", date)
    .in("status", ["success", "partial"])
    .order("created_at", { ascending: false })
    .limit(1);
  const runId = runs?.[0]?.id ?? null;
  if (!runId) {
    console.log(`  ${date}  skipped — no completed run to attribute the rows to`);
    continue;
  }

  try {
    const pulled = await pullAll(date);
    const recentFloorByCity = await loadRecentFloorBarcodes(db, date);
    // Same call shape as lib/reconcile/pipeline.ts — including runDate as the
    // fallback date, so a city with no register and a quiet DT still reconciles
    // its remaining sources against the day we asked for.
    const run = runAllCities(
      pulled.rowsByCity,
      new Date(),
      pulled.reportedByCity,
      recentFloorByCity,
      date
    );
    const n = await upsertMovementEvents(db, runId, run.perCity, { backfilled: true });
    total += n;
    const clean = run.perCity.reduce(
      (a, c) => a + c.movement_events.filter((e) => e.outcome === "CLEAN").length,
      0
    );
    console.log(`  ${date}  ${String(n).padStart(5)} events  (${clean} clean)`);
  } catch (e) {
    console.error(`  ${date}  FAILED: ${e instanceof Error ? e.message : e}`);
  }
}

console.log(`\n${total} events written, all flagged backfilled=true.`);
console.log("Anything before the dates listed above has no history and cannot get one.");
