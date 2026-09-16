// What the 13 Sep 2026 calendar-day cutover actually changes — measured by
// running the REAL connectors both ways over the same dates.
//
// WHY NOT ab-replay.mts. That harness replays STORED source_rows through the
// engine, which is right for an engine change and blind to this one: almost all
// of this change is in what the connectors PULL and which day they attribute it
// to. Stored rows were pulled under the old rule, so replaying them would show
// a near-empty diff and prove nothing.
//
// Both sides run the same code; only CALENDAR_DAYS_FROM differs, so the delta
// is attributable to the cutover and nothing else.
//
//   npx tsx scripts/cutover-replay.mts 2026-09-13 2026-09-14 2026-09-15
//
// Read-only: it pulls and runs the engine in memory and writes nothing.

import { odooConnector } from "../lib/connectors/odoo";
import { dtConnector } from "../lib/connectors/dt";
import { sheetsConnector } from "../lib/connectors/sheets";
import { guardConnector } from "../lib/connectors/guard";
import type { CityTaggedRow, PullContext } from "../lib/connectors/types";

const DATES = process.argv.slice(2).filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
if (DATES.length === 0) {
  console.error("usage: cutover-replay.mts <date> [date…]");
  process.exit(1);
}

const CITY = process.env.REPLAY_CITY ?? "DELHI";

interface Tally {
  total: number;
  byDir: Record<string, number>;
  /** Canonical-ish identity so the two sides can be compared unit by unit. */
  keys: Set<string>;
}

const empty = (): Tally => ({ total: 0, byDir: { IN: 0, OUT: 0 }, keys: new Set() });

async function pullAll(date: string): Promise<Record<string, Tally>> {
  const ctx = { warn: () => {}, incomplete: () => {} };
  const out: Record<string, Tally> = {};
  const connectors = [
    ["Guard Check", guardConnector],
    ["Manual Sheet", sheetsConnector],
    ["Delivery Tracker", dtConnector],
    ["Odoo", odooConnector],
  ] as const;

  for (const [label, conn] of connectors) {
    const t = empty();
    try {
      const rows = (await conn.pull(date, ctx as PullContext)) as CityTaggedRow[];
      for (const r of rows) {
        if (r.city !== CITY) continue;
        t.total++;
        t.byDir[r.direction] = (t.byDir[r.direction] ?? 0) + 1;
        t.keys.add(`${r.direction}::${String(r.barcode ?? "").toUpperCase().trim()}`);
      }
    } catch (e) {
      console.error(`  ! ${label} failed for ${date}: ${String(e).slice(0, 160)}`);
    }
    out[label] = t;
  }
  return out;
}

const side = process.env.CALENDAR_DAYS_FROM === "2099-01-01" ? "OLD (15:00→15:00)" : "NEW (calendar)";
console.log(`# ${side} · city ${CITY}\n`);

for (const date of DATES) {
  const pulls = await pullAll(date);
  console.log(`## ${date}`);
  for (const [label, t] of Object.entries(pulls)) {
    console.log(`${label.padEnd(18)} total ${String(t.total).padStart(5)}   in ${String(t.byDir.IN ?? 0).padStart(4)}   out ${String(t.byDir.OUT ?? 0).padStart(4)}`);
    // The unit keys, sorted, so a diff of two runs names the rows that moved
    // rather than only the size of the move.
    for (const k of [...t.keys].sort()) console.log(`  ${label} ${k}`);
  }
  console.log("");
}

process.exit(0);
