// One-time backfill for run_city_stats (leaderboard rollup), for reconciliation
// runs that were persisted BEFORE saveCityStats existed. Going forward the
// reconcile cron populates run_city_stats automatically.
//
//   real/info/high per city  ← aggregate the variances table by run_id (exact)
//   movements per city        ← distinct (direction, barcode) in source_rows by
//                               run_id, WHERE still retained (source_rows prune
//                               after 7 days). Older runs get movements=0 and
//                               are reported, so you know the denominator is
//                               missing (re-run reconcile for an exact figure).
//
// Processes the LATEST run per business_date; upserts on (business_date, city).
// Run:  node scripts/backfill-city-stats.mjs
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf-8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const e = t.indexOf("=");
  if (e < 0) continue;
  env[t.slice(0, e).trim()] = t.slice(e + 1).trim();
}
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const CITIES = ["DELHI", "MUMBAI", "PUNE", "HYDRABAD", "BANGALORE"];

async function pageAll(table, columns, runId) {
  let all = [];
  let from = 0;
  for (;;) {
    const { data, error } = await db.from(table).select(columns).eq("run_id", runId).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

async function main() {
  const { data: runs, error } = await db
    .from("reconciliation_runs")
    .select("id, business_date, created_at")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  // Latest run per business_date (ascending order → last write wins).
  const latestByDate = new Map();
  for (const r of runs) latestByDate.set(r.business_date, r);

  let seeded = 0;
  for (const [date, run] of latestByDate) {
    const variances = await pageAll("variances", "city, bucket, priority", run.id);
    const sourceRows = await pageAll("source_rows", "city, direction, barcode", run.id);

    const per = new Map(CITIES.map((c) => [c, { movements: 0, real_count: 0, info_count: 0, high_count: 0 }]));
    for (const v of variances) {
      const p = per.get(v.city);
      if (!p) continue;
      if (v.bucket === "REAL") p.real_count++;
      else if (v.bucket === "INFO") p.info_count++;
      if (v.priority === "High") p.high_count++;
    }
    // movements ≈ distinct (direction, upper barcode) per city from source_rows.
    const seen = new Map(CITIES.map((c) => [c, new Set()]));
    for (const s of sourceRows) {
      const set = seen.get(s.city);
      if (!set || !s.barcode) continue;
      set.add(s.direction + "|" + String(s.barcode).toUpperCase().replace(/\s+/g, ""));
    }
    for (const c of CITIES) per.get(c).movements = seen.get(c).size;

    const payload = CITIES.map((c) => ({ run_id: run.id, business_date: date, city: c, ...per.get(c) }));
    const { error: upErr } = await db.from("run_city_stats").upsert(payload, { onConflict: "business_date,city" });
    if (upErr) throw new Error(`upsert ${date}: ${upErr.message}`);
    seeded++;
    const noMoves = payload.every((p) => p.movements === 0);
    console.log(
      `  ${date}: seeded ${payload.length} cities` +
        (noMoves ? "  (movements=0 — source_rows pruned; re-run reconcile for exact denominator)" : "")
    );
  }
  console.log(`Done. ${seeded} date(s) backfilled into run_city_stats.`);
}

main().catch((e) => {
  console.error("BACKFILL FAILED:", e.message);
  process.exit(1);
});
