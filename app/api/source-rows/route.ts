// GET /api/source-rows — the raw rows behind one cell of the scoreboard.
//
// The scoreboard says "Odoo · inward · 51". This is the 51: the rows exactly as
// that source handed them over, before the engine matched, folded, deduped or
// dropped anything.
//
// WHY RAW AND NOT THE LEDGER. movement_events is the reconciled view — one row
// per unit per direction, with the four presence flags. It is the right thing
// for the gate-anchored cards and the wrong thing here, because a scoreboard
// figure is a count of what a BOOK said, and the interesting differences are
// exactly what reconciliation removes: a barcode written twice, a sheet row
// marked "Not Delivered", a PP box line with no serial. Reading the ledger
// would quietly answer a different question and the numbers would not add up.
//
// Retention: source_rows holds 43 days (measured 16 Sep 2026 — 3 Aug onward,
// 112,427 rows), so a cell for an older date opens empty. The screen says so
// rather than showing nothing and implying the source was silent.

import { NextResponse, type NextRequest } from "next/server";
import { jsonRoute } from "@/lib/api/json-route";
import { createClient } from "@/lib/supabase/server";
import { dayToUtcWindow, usesCalendarDay } from "@/lib/connectors/ist-window";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The stored source codes. The screen names them; the database keys on these. */
const SOURCES = ["ODOO", "SHEET", "DT", "PHYSICAL"] as const;

const PAGE = 1000;

export const GET = jsonRoute("source-rows", async (req: NextRequest) => {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const date = sp.get("date");
  const source = sp.get("source");
  const direction = sp.get("direction");
  const city = sp.get("city");
  if (!date || !source || !SOURCES.includes(source as (typeof SOURCES)[number])) {
    return NextResponse.json({ error: "date and a valid source are required" }, { status: 400 });
  }

  // THE GATE IS READ FROM ITSELF, not from source_rows. A scan is a barcode and
  // a time and nothing else — the connector passes on exactly that, so the
  // copy in source_rows has no clock, no product, no customer (reported
  // 18 Sep 2026: every column blank but the barcode). gate_scans holds the
  // scan time AND the details looked up afterwards against Odoo and DT.
  // Reading the table directly gives the same rows the figure counts —
  // barcoded, recorded, that day — with everything known about them.
  //
  // The looked-up details are flagged, and the screen draws them differently:
  // they are Odoo's answer about the unit, not something the guard asserted.
  if (source === "PHYSICAL") {
    let g = supabase
      .from("gate_scans")
      .select("written:barcode, direction, scanned_at, unit_product, task_customer, task_so, task_ticket, task_job_type, task_matched")
      .eq("status", "recorded")
      .not("barcode", "is", null)
      .order("scanned_at", { ascending: true })
      .limit(PAGE);
    if (usesCalendarDay(date)) {
      const w = dayToUtcWindow(date);
      g = g.gte("scanned_at", w.startUtc).lt("scanned_at", w.endUtcExclusive);
    } else {
      g = g.eq("business_date", date);
    }
    if (city && city !== "ALL") g = g.eq("city", city);
    if (direction === "IN" || direction === "OUT") g = g.eq("direction", direction);
    const gr = await g;
    if (gr.error) return NextResponse.json({ error: gr.error.message }, { status: 500 });
    const grows = (gr.data ?? []) as Record<string, unknown>[];
    return NextResponse.json({
      rows: grows.map((r) => ({
        barcodeAsWritten: (r.written as string) ?? "",
        direction: r.direction as string,
        status: "scanned",
        jobType: (r.task_job_type as string) ?? null,
        soNumber: (r.task_so as string) ?? null,
        ticketId: (r.task_ticket as string) ?? null,
        customer: (r.task_customer as string) ?? null,
        product: (r.unit_product as string) ?? null,
        recordedAt: (r.scanned_at as string) ?? null,
        lookedUp: true,
        lastKnown: !r.task_matched,
      })),
      pruned: false,
      capped: grows.length === PAGE,
    });
  }

  // Scoped to ONE run. source_rows keeps every re-check pass for a date, so an
  // unscoped read returns the same day several times over — 4,106 rows for a
  // day the run pulled 896 (trap 2).
  const runRes = await supabase
    .from("reconciliation_runs")
    .select("id")
    .eq("business_date", date)
    .in("status", ["success", "partial"])
    .order("created_at", { ascending: false })
    .limit(1);
  if (runRes.error) return NextResponse.json({ error: runRes.error.message }, { status: 500 });
  const runId = runRes.data?.[0]?.id;
  if (!runId) return NextResponse.json({ rows: [], pruned: false, runMissing: true });

  // `written:barcode` — the spelling the source itself used, aliased so no
  // caller can mistake it for the canonical fold (invariant 6).
  let q = supabase
    .from("source_rows")
    .select("written:barcode, direction, status, job_type, so_number, ticket_id, customer, product, movement_date, created_on, ot:raw->>orderTransferRef")
    .eq("run_id", runId)
    .eq("source", source)
    .limit(PAGE);
  if (city && city !== "ALL") q = q.eq("city", city);
  if (direction === "IN" || direction === "OUT") q = q.eq("direction", direction);

  const res = await q.order("direction", { ascending: true });
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });

  let rows = (res.data ?? []) as Record<string, unknown>[];

  // ODOO IS PULLED WIDER THAN IT IS COUNTED. The reconciliation window is
  // run-1 .. run+1 on posting date, deliberately, so a next-day posting still
  // matches the day's movement. The scoreboard's Odoo column counts SAME-DAY
  // postings only, because a movement table stacking three days into one column
  // dwarfs every other book.
  //
  // So the raw feed holds more Odoo rows than the figure a person just clicked.
  // Narrowing here keeps the modal an explanation of that figure rather than a
  // contradiction of it — the same rule computeCountLayer applies.
  if (source === "ODOO") {
    const day = (v: unknown) => (typeof v === "string" ? v.slice(0, 10) : null);
    rows = rows.filter((r) => (day(r.created_on) ?? day(r.movement_date)) === date);
  }

  return NextResponse.json({
    rows: rows.map((r) => ({
      barcodeAsWritten: (r.written as string) ?? "",
      direction: r.direction as string,
      status: (r.status as string) ?? null,
      jobType: (r.job_type as string) ?? null,
      soNumber: (r.so_number as string) ?? null,
      ticketId: (r.ticket_id as string) ?? null,
      customer: (r.customer as string) ?? null,
      product: (r.product as string) ?? null,
      // Odoo's is a posting time, DT's is when the agent handled the item, and
      // the sheet has none at all. Labelled on screen as "recorded at" rather
      // than as the moment the goods moved, which none of them is.
      recordedAt: (r.movement_date as string) ?? (r.created_on as string) ?? null,
      // An order transfer is listed — it is on Odoo's own screen — but it is
      // not a movement and not in the figure; the modal says so row by row.
      orderTransferRef: (r.ot as string) ?? null,
    })),
    // An empty cell for a date outside retention is not the same claim as a
    // source that reported nothing, and must not render as one.
    pruned: rows.length === 0,
    capped: rows.length === PAGE,
  });
});
