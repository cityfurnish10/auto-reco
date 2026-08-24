// Find DT's field names WITHOUT a Mongo connection.
//
// The reconcile pipeline runs on Vercel, where DT_MONGODB_URI is set; that
// value is marked sensitive so `vercel env pull` returns "[SENSITIVE]" and it
// has never been on a developer machine. But every pull writes what it read
// into Postgres, and this machine does have read-only SQL. So the question
// "which field holds the delivery agent" can be answered from the copy rather
// than the original.
//
// Read-only.
//
//   node scripts/dt-fields-from-db.mjs

import { connectReadonly } from "./db-connect.mjs";

const c = await connectReadonly();
try {
  // What does the DT connector actually persist, and where?
  const cols = await c.query(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('source_rows','reconcile_runs')
    ORDER BY table_name, ordinal_position`);
  console.log("COLUMNS");
  for (const r of cols.rows) console.log(`  ${r.table_name}.${r.column_name} :: ${r.data_type}`);

  const jsonCols = cols.rows.filter((r) => /json/.test(r.data_type) && r.table_name === "source_rows");
  if (!jsonCols.length) {
    console.log("\nNo JSON column on source_rows — the raw DT document is not kept.");
  }

  for (const jc of jsonCols) {
    const { rows } = await c.query(
      `SELECT jsonb_object_keys(${jc.column_name}::jsonb) AS k, count(*) AS n
       FROM source_rows
       WHERE source = 'DT' AND ${jc.column_name} IS NOT NULL
       GROUP BY 1 ORDER BY 2 DESC LIMIT 60`
    ).catch((e) => ({ rows: [{ k: `(${e.message.slice(0, 80)})`, n: 0 }] }));
    console.log(`\nKEYS INSIDE source_rows.${jc.column_name} FOR source='DT'`);
    if (!rows.length) console.log("  (none — DT rows carry no raw document)");
    for (const r of rows) console.log(`  ${String(r.n).padStart(6)}  ${r.k}`);
  }

  // Whatever DT rows exist, show one so the shape is visible.
  const sample = await c.query(
    `SELECT * FROM source_rows WHERE source = 'DT' ORDER BY id DESC LIMIT 1`
  ).catch(() => ({ rows: [] }));
  if (sample.rows.length) {
    console.log("\nONE DT ROW AS STORED");
    for (const [k, v] of Object.entries(sample.rows[0])) {
      const s = v === null ? "null" : typeof v === "object" ? JSON.stringify(v) : String(v);
      console.log(`  ${k.padEnd(22)} ${s.slice(0, 120)}`);
    }
  } else {
    console.log("\nNo DT rows in source_rows at all.");
  }
} finally {
  await c.end();
}
