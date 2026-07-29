// GET /api/sources — raw source rows for a run (drilldown behind a variance).
// Query params: run_id (required), source, city, barcode, page, pageSize.
//
// The `barcode` filter matches the CANONICAL form, not the raw one. Callers pass
// variances.barcode, which is already canonical; source_rows.barcode is the raw
// spelling the connector produced, and the two differ on 54% of rows (measured
// 2026-07-29, concentrated in Odoo and DT, because canonicalize() folds
// I->1 O->0 S->5 Z->2 G->6).
//
// Matching raw-against-canonical meant the evidence panel found nothing for
// 117 of the 203 variance rows on 2026-07-26 and rendered "No record" against
// sources that had the unit — an affirmative false accusation, not a blank.
// Migration 0014 adds source_rows.barcode_canonical (generated, indexed) so
// PostgREST can filter on it; see that file for why a generated column rather
// than an expression index.

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { canonicalize } from "@/lib/engine/barcode";

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const runId = sp.get("run_id");
  if (!runId) {
    return NextResponse.json({ error: "run_id is required" }, { status: 400 });
  }

  const page = Math.max(1, Number(sp.get("page")) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(sp.get("pageSize")) || 100));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const source = sp.get("source");
  const city = sp.get("city");
  const barcode = sp.get("barcode");
  // Canonicalize defensively: callers already send the canonical form, but this
  // makes a hand-edited URL work too, and it is idempotent on canonical input.
  const canon = barcode ? canonicalize(barcode) : null;

  // A PostgREST builder is consumed once, so the 0014 fallback needs a fresh
  // one — same reason /api/variances wraps its query for the 0011 retry.
  const build = (barcodeCol: "barcode_canonical" | "barcode") => {
    let query = supabase
      .from("source_rows")
      .select("*", { count: "exact" })
      .eq("run_id", runId)
      // Deterministic tiebreak. saveSourceRows inserts in 1000-row chunks that
      // share a created_at, and .range() over ties can repeat or skip rows
      // across pages — the same defect already fixed in persist.ts and
      // register-pdf.ts.
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to);

    if (source) query = query.eq("source", source);
    if (city) query = query.eq("city", city);
    if (barcode) {
      query = query.eq(barcodeCol, barcodeCol === "barcode_canonical" ? canon! : barcode);
    }
    return query;
  };

  let degraded = false;
  let { data, error, count } = await build("barcode_canonical");

  // 42703 = undefined_column; PostgREST reports an unknown column as PGRST204
  // ("Could not find the 'x' column ... in the schema cache"). Migrations here
  // are applied by hand, so the route must work either side of 0014 — it just
  // reverts to the old raw match, which is no worse than before.
  //
  // Guarded on `barcode &&` so an unrelated 42703 does not buy a pointless
  // second round trip.
  if (
    barcode &&
    error &&
    (error.code === "42703" ||
      error.code === "PGRST204" ||
      /does not exist|could not find/i.test(error.message))
  ) {
    degraded = true;
    ({ data, error, count } = await build("barcode"));
  }

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    data,
    page,
    pageSize,
    total: count ?? 0,
    totalPages: count ? Math.ceil(count / pageSize) : 0,
    // The UI says so out loud rather than silently under-reporting evidence.
    ...(degraded ? { degraded: "barcode_canonical" as const } : {}),
  });
}
