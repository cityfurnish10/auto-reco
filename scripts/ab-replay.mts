// A/B replay harness — the only trustworthy way to measure an engine change.
//
// Replays stored source_rows through the REAL runReconciliation, scoped to ONE
// run_id per day. That scoping is not optional: source_rows retains every
// re-check pass, and replaying all of them is exactly how an earlier attempt
// manufactured +10,981 phantom duplicates and looked plausible doing it.
//
//   npx tsx scripts/ab-replay.mts > before.txt
//   git stash && npx tsx scripts/ab-replay.mts > after.txt && git stash pop
//   diff before.txt after.txt
//
// LIMITATION, and why it does not matter: source_rows does not persist Odoo's
// create_date (recordCreatedOn), which gates the REAL "Odoo Entry Created Today"
// rung. So absolute counts here will not match production. The harness is
// IDENTICAL on both sides, so that inaccuracy cancels and the DELTA is
// attributable purely to the change under test. Read the diff, never the total.
import { connectReadonly } from "./db-connect.mjs";
import { runReconciliation } from "../lib/engine/run";
import type { SourceRow } from "../lib/engine/types";

const DAYS = Number(process.env.AB_DAYS ?? 8);
// AB_FROM/AB_TO pin the window. Default (most recent days) is fine for a broad
// regression check, but a change must be replayed over days that actually
// CONTAIN the data it touches — otherwise an identical diff proves only that
// the window was empty of the thing under test.
const FROM = process.env.AB_FROM ?? null;
const TO = process.env.AB_TO ?? null;
const c = await connectReadonly();
const days: string[] = (await c.query(
  FROM && TO
    ? `SELECT business_date::text d FROM source_rows
        WHERE business_date BETWEEN '${FROM}' AND '${TO}' GROUP BY 1 ORDER BY 1`
    : `SELECT business_date::text d FROM source_rows GROUP BY 1 ORDER BY 1 DESC LIMIT ${DAYS}`
)).rows.map((r: { d: string }) => r.d);

const out: string[] = [];
for (const d of days) {
  const { rows: [pick] } = await c.query(
    `SELECT run_id FROM source_rows WHERE business_date=$1
     GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`, [d]);
  if (!pick) continue;
  const { rows } = await c.query(
    `SELECT source, direction, barcode, job_type AS "jobType", so_number AS "soNumber",
            ticket_id AS "ticketId", customer, product, status, city, date,
            created_on AS "createdOn", movement_date AS "movementDate"
       FROM source_rows WHERE run_id=$1`, [pick.run_id]);
  const byCity = new Map<string, SourceRow[]>();
  for (const r of rows) {
    const list = byCity.get(r.city) ?? [];
    list.push(r as SourceRow);
    byCity.set(r.city, list);
  }
  for (const [city, cityRows] of byCity) {
    // reported-awareness DERIVED from the feed, not defaulted. Passing
    // ALL_REPORTED here is one of the two mistakes that invalidated an earlier
    // attempt at this measurement: the ladder blames a source for an absence
    // only when it actually filed, so a defaulted `reported` changes the
    // classification of every city whose register never arrived.
    const has = (src: string) => cityRows.some((r) => r.source === src);
    const reported = { P: has("PHYSICAL"), S: has("SHEET"), D: has("DT"), O: has("ODOO") };
    // recentFloor / recentOdoo stay empty: the pipeline builds them from
    // source_rows history. Empty on BOTH sides, so it cancels.
    const res = runReconciliation(cityRows, city as never, reported, new Set(), d, new Set());
    for (const v of res.variances)
      out.push(`${d}|${city}|${v.direction}|${v.barcode}|${v.variance_name}|${v.job_type ?? ""}`);
  }
}
out.sort();
console.log(`${out.length} variance rows across ${days.length} days`);
console.log(out.join("\n"));
await c.end();
