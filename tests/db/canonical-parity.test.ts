// Proves the SQL twin in migration 0014 agrees with canonicalize() on every row
// the database actually holds.
//
// This is the test. A unit test can only check the cases someone thought of;
// source_rows carries ~72k real rows from four connectors, including OCR of a
// handwritten register, and that is where a locale surprise or an unnoticed
// whitespace character would show up.
//
// OPT-IN. It pages every retained source_rows row (68k+ and growing) over ~90
// seconds, which is far too slow to sit in the default suite — left there it
// simply trains people to skip tests. Run it deliberately, after applying 0014
// or after any change to FOLD in lib/engine/barcode.ts:
//
//   PARITY_LIVE=1 npx vitest run tests/db/canonical-parity.test.ts

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { canonicalize } from "../../lib/engine/barcode";

// vitest does not read .env.local; load it the same way the scratch scripts do.
function loadEnv(): void {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  const raw = fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  for (const m of raw.matchAll(/^([A-Z_][A-Z0-9_]*)=("[\s\S]*?"|[^\n]*)$/gm)) {
    if (process.env[m[1]]) continue;
    try {
      process.env[m[1]] = JSON.parse(m[2]);
    } catch {
      process.env[m[1]] = m[2].replace(/^"|"$/g, "");
    }
  }
}
loadEnv();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const live = !!(url && key) && process.env.PARITY_LIVE === "1";

const db: SupabaseClient = live
  ? createClient(url!, key!, { auth: { autoRefreshToken: false, persistSession: false } })
  : (null as never);

// Migrations here are applied by hand, so probe once rather than reporting a
// missing migration as three test failures. 42703 = undefined_column;
// PGRST202/PGRST204 = PostgREST could not find the function/column.
async function migrationApplied(): Promise<boolean> {
  if (!live) return false;
  const { error } = await db.from("source_rows").select("barcode_canonical").limit(1);
  if (!error) return true;
  if (
    error.code === "42703" ||
    error.code === "PGRST204" ||
    /does not exist|could not find/i.test(error.message)
  ) {
    console.warn(
      "[canonical-parity] migration 0014 not applied — skipping. " +
        "Apply supabase/migrations/0014_canonical_barcode.sql, then re-run."
    );
    return false;
  }
  throw new Error(`${error.code ?? ""} ${error.message}`.trim());
}
const applied = await migrationApplied();

describe.skipIf(!applied)("migration 0014 — SQL canonicalize matches the engine", () => {

  type Row = { id: string; source: string; barcode: string; barcode_canonical: string };
  // Paged once and shared. Each pass is ~68 sequential round trips; fetching
  // twice took the file to 178s and blew its own timeout inside the full suite.
  let cached: Row[] | null = null;

  async function allRows(): Promise<Row[]> {
    if (cached) return cached;
    const out: Row[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from("source_rows")
        .select("id, source, barcode, barcode_canonical")
        // Stable key — an unordered .range() can repeat or skip rows.
        .order("id", { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error(`${error.code ?? ""} ${error.message}`.trim());
      out.push(...((data ?? []) as Row[]));
      if (!data || data.length < 1000) break;
    }
    cached = out;
    return out;
  }

  it("agrees with canonicalize() on every retained source row", async () => {
    const rows = await allRows();
    expect(rows.length, "no source_rows retained — nothing was verified").toBeGreaterThan(0);

    const bad = rows.filter((r) => canonicalize(r.barcode) !== r.barcode_canonical);
    if (bad.length > 0) {
      // JSON.stringify so invisible characters render as   rather than
      // vanishing into the terminal, which is how this class of bug hides.
      const sample = bad
        .slice(0, 20)
        .map(
          (r) =>
            `  ${r.source} raw=${JSON.stringify(r.barcode)} sql=${JSON.stringify(
              r.barcode_canonical
            )} ts=${JSON.stringify(canonicalize(r.barcode))}`
        )
        .join("\n");
      throw new Error(
        `${bad.length} of ${rows.length} rows disagree between canonicalize_barcode() and canonicalize():\n${sample}`
      );
    }
    expect(bad).toHaveLength(0);
  }, 240_000);

  it("actually folds a meaningful share — a no-op expression must not pass", async () => {
    // Measured 2026-07-29: 54% of sampled rows differ from their canonical
    // form. If translate() were misspelled the parity test above would still
    // pass trivially (both sides equal the raw string), so assert the fold does
    // real work. The band is wide because the mix shifts with the day's volume.
    const rows = await allRows();
    const folded = rows.filter((r) => r.barcode !== r.barcode_canonical).length;
    const share = folded / rows.length;
    expect(share, `only ${folded}/${rows.length} rows folded`).toBeGreaterThan(0.3);
    expect(share).toBeLessThan(0.8);
  }, 240_000);

  it("gives the same answer as the engine for the two live failure cases", async () => {
    const { data, error } = await db.rpc("canonicalize_barcode", { raw: "FUIOL223020032" });
    if (error) throw new Error(`${error.code ?? ""} ${error.message}`.trim());
    expect(data).toBe("FU10L223020032");
    expect(data).toBe(canonicalize("FUIOL223020032"));
  });
});
