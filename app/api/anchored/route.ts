// GET /api/anchored — the day's movements, read with the GATE as the anchor.
//
// The counts live on /api/stats/summary (same ledger read, already fetched by
// the dashboard). This returns the ROWS behind one card, when somebody opens it.
//
// WHY THE GATE ANCHORS. Decided 15 Sep 2026 after trying Odoo and the Delivery
// Tracker in turn. Neither works as the reference: Odoo does not know a truck
// left, only that a document was validated — and it validates outward about 26
// hours late; the Tracker covers agent tasks only and missed 44% of Delhi's
// movements on 13 Sep. The guard is the one source physically present when
// goods cross, so where it has a record, that record stands.
//
// AND WHY ITS SILENCE DOES NOT. Delhi's gate witnessed 26%, then 42%, then 60%
// of each day's movements as coverage improved that week. On 13 Sep, 118
// movements had Odoo, the sheet and the Tracker all agreeing with nothing at
// the gate. Treating the gate's absence as authority would file those as
// variances against three books that were right. So "not seen by the gate" is
// its own bucket, and it is a question about coverage rather than about stock —
// until the guards cover the whole day, which the bucket's own count is the way
// to watch for.

import { NextResponse, type NextRequest } from "next/server";
import { jsonRoute } from "@/lib/api/json-route";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The five groups the dashboard draws, as a card each. */
export type AnchoredBucket =
  | "confirmedAll"
  | "gateNotOdoo"
  | "gateNotSheet"
  | "gateNotDt"
  | "notSeenByGate";

const PAGE = 1000;

export const GET = jsonRoute("anchored", async (req: NextRequest) => {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const bucket = sp.get("bucket") as AnchoredBucket | null;
  const date = sp.get("date");
  const city = sp.get("city");
  // Section 3's "each book as the source of truth" cards (18 Sep 2026):
  //   truth=<book> [&vs=<book>&kind=matched|notMatched | &kind=all|allMatched|notAll] &direction=IN|OUT
  // A book's presence is its present_* flag, except Odoo, which is counted on
  // its own 3pm window (odoo_same_day) so the list ties to the scoreboard.
  const truth = sp.get("truth");
  const COL: Record<string, string> = { gate: "present_p", sheet: "present_s", dt: "present_d", odoo: "odoo_same_day" };
  if (truth && !COL[truth]) return NextResponse.json({ error: "unknown truth source" }, { status: 400 });
  if (!truth && !bucket || !date) {
    return NextResponse.json({ error: "bucket and date required" }, { status: 400 });
  }

  // The run to read. The ledger never deletes, so rows the newest run no longer
  // emits linger under older run_ids and would double-count — every read here
  // is scoped to one run, as the summary's is.
  const runRes = await supabase
    .from("reconciliation_runs")
    .select("id")
    .eq("business_date", date)
    .in("status", ["success", "partial"])
    .order("created_at", { ascending: false })
    .limit(1);
  if (runRes.error) return NextResponse.json({ error: runRes.error.message }, { status: 500 });
  const runId = runRes.data?.[0]?.id;
  if (!runId) return NextResponse.json({ rows: [], total: 0, runMissing: true });

  // RLS scopes a manager to their own city; the filter below only narrows it
  // further, and can never widen it.
  let q = supabase
    .from("movement_events")
    .select("barcode, barcode_display, direction, job_type, so_number, ticket_id, customer, product, present_p, present_s, present_d, present_o, odoo_same_day")
    .eq("run_id", runId)
    .eq("is_movement", true)
    .limit(PAGE);
  if (city && city !== "ALL") q = q.eq("city", city);

  const direction = sp.get("direction");
  if (direction === "IN" || direction === "OUT") q = q.eq("direction", direction);

  if (truth) {
    q = q.eq(COL[truth], true);
    const kind = sp.get("kind");
    const vs = sp.get("vs");
    if (vs && COL[vs] && (kind === "matched" || kind === "notMatched")) {
      q = q.eq(COL[vs], kind === "matched");
    } else if (kind === "allMatched") {
      for (const [k, col] of Object.entries(COL)) if (k !== truth) q = q.eq(col, true);
    } else if (kind === "notAll") {
      // The complement of allMatched: at least one other book lacks it.
      // "not.is.true" and not "eq.false" — odoo_same_day can be null.
      q = q.or(Object.entries(COL).filter(([k]) => k !== truth).map(([, col]) => `${col}.not.is.true`).join(","));
    }
  } else
  // Each card is one presence pattern. Expressed as filters rather than read
  // and sifted in memory, so a 2,000-row day does not travel to draw 20 rows.
  if (bucket === "notSeenByGate") {
    q = q.eq("present_p", false);
  } else {
    q = q.eq("present_p", true);
    if (bucket === "confirmedAll") q = q.eq("present_o", true).eq("present_s", true).eq("present_d", true);
    if (bucket === "gateNotOdoo") q = q.eq("present_o", false);
    if (bucket === "gateNotSheet") q = q.eq("present_s", false);
    if (bucket === "gateNotDt") q = q.eq("present_d", false);
  }

  const res = await q.order("direction", { ascending: true });
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });

  const rows = (res.data ?? []) as Record<string, unknown>[];
  return NextResponse.json({
    rows: rows.map((r) => ({
      // The spelling a source actually wrote, never the fold (invariant 6).
      // NAMED for what it is: a field called `barcode` here would read as the
      // canonical fold at every call site, which is the bug that rule exists
      // to stop.
      barcodeDisplay: (r.barcode_display as string) || (r.barcode as string),
      direction: r.direction as string,
      jobType: (r.job_type as string) ?? null,
      soNumber: (r.so_number as string) ?? null,
      ticketId: (r.ticket_id as string) ?? null,
      customer: (r.customer as string) ?? null,
      product: (r.product as string) ?? null,
      seenBy: [
        r.present_p ? "Guard Check" : null,
        (truth ? r.odoo_same_day : r.present_o) ? "Odoo" : null,
        r.present_s ? "Manual Sheet" : null,
        r.present_d ? "Delivery Tracker" : null,
      ].filter(Boolean).join(", "),
    })),
    total: rows.length,
    // A day at the cap is a day whose list is incomplete, and the screen has to
    // say so rather than quietly showing the first thousand.
    capped: rows.length === PAGE,
  });
});
