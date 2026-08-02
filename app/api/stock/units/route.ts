// GET /api/stock/units?date=&a=&b=&class=cleared|still-open|newly-raised
//
// The drill-down behind one delta cell. Paginated, because the units for a busy
// day are hundreds of rows and the compare route deliberately carries none.
//
// The honest asymmetry this route has to surface: still-open and newly-raised
// units still have a live variances row and carry ticket/product/customer. A
// CLEARED unit may not — resolveStaleOpenVariances hard-DELETEs superseded rows,
// so all that survives is the key the snapshot stored. Those come back with
// rowPresent:false and null detail rather than being silently dropped.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { readRuns, readSnapshots, readVarianceDetail } from "@/lib/stock/db";
import { toPasses } from "@/lib/stock/passes";
import { foldPass, parseSnapshotRow } from "@/lib/stock/snapshot";
import { reasonFor, unitsOf } from "@/lib/stock/compare";
import { classifyRows, unitKeyOfRow } from "@/lib/email/followup/compare";
import { labelFor } from "@/lib/ui/variance-labels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CLASSES = ["cleared", "still-open", "newly-raised"] as const;
const MAX_PAGE = 200;

export async function GET(req: NextRequest) {
  const me = await getCurrentAppUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const q = req.nextUrl.searchParams;
  const date = (q.get("date") ?? "").trim();
  const klass = (q.get("class") ?? "") as (typeof CLASSES)[number];
  if (!DATE_RE.test(date)) {
    return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }
  if (!CLASSES.includes(klass)) {
    return NextResponse.json({ error: `class must be one of ${CLASSES.join("|")}` }, { status: 400 });
  }
  const page = Math.max(1, Number(q.get("page") ?? 1) || 1);
  const pageSize = Math.min(MAX_PAGE, Math.max(1, Number(q.get("pageSize") ?? 50) || 50));
  const city = q.get("city");

  const db = createAdminClient();
  let runs, snapRows, detail;
  try {
    [runs, snapRows, detail] = await Promise.all([
      readRuns(db, date),
      readSnapshots(db, date),
      readVarianceDetail(db, date),
    ]);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  if (snapRows === null) {
    return NextResponse.json({ total: 0, page, pageSize, rows: [], degraded: "unavailable" });
  }

  const { passes } = toPasses(runs);
  const parsed = snapRows.map(parseSnapshotRow).filter((s) => s !== null);
  const byRun = new Map<string, NonNullable<typeof parsed[number]>[]>();
  for (const s of parsed) {
    const list = byRun.get(s!.runId) ?? [];
    list.push(s!);
    byRun.set(s!.runId, list);
  }
  for (const p of passes) p.hasSnapshot = byRun.has(p.runId);

  const eligible = passes.filter((p) => p.hasSnapshot && !p.preClose);
  const aId = q.get("a") ?? eligible[0]?.runId;
  const aPass = passes.find((p) => p.runId === aId);
  const bId =
    q.get("b") ?? [...eligible].reverse().find((p) => aPass && p.lagDays > aPass.lagDays)?.runId;
  if (!aId || !bId || !byRun.has(aId) || !byRun.has(bId)) {
    return NextResponse.json({ total: 0, page, pageSize, rows: [], degraded: "unavailable" });
  }

  const foldedA = foldPass(aId, date, byRun.get(aId)!);
  const foldedB = foldPass(bId, date, byRun.get(bId)!);

  // Detail keyed by unit, worst tier first so a two-row unit shows its worst
  // face. The comment said this; the code was first-row-wins, so which of a
  // unit's rows got shown came down to the order the rows happened to arrive in
  // — a unit flagged both "Stock at risk" and "For information" could present
  // itself as the latter. Tier 1 is the worst, so the lower number wins.
  const tierOfDetail = (d: (typeof detail)[number]) =>
    labelFor(d.variance_name, {
      direction: (d.direction as "IN" | "OUT" | "CROSS" | null) ?? null,
      jobType: d.job_type,
      bucket: (d.bucket as "REAL" | "INFO" | null) ?? null,
      note: d.note,
    }).tier;
  const byUnit = new Map<string, (typeof detail)[number]>();
  for (const d of detail) {
    const k = unitKeyOfRow(d);
    const prev = byUnit.get(k);
    if (!prev || tierOfDetail(d) < tierOfDetail(prev)) byUnit.set(k, d);
  }
  const closedUnits = new Set(
    classifyRows(
      detail.map((d) => ({
        city: d.city, direction: d.direction, barcode: d.barcode,
        variance_name: d.variance_name, job_type: d.job_type, bucket: d.bucket,
        note: d.note, status: d.status,
      }))
    ).closed.keys()
  );

  let units = unitsOf(foldedA, foldedB, klass);
  if (city) units = units.filter((u) => u.startsWith(`${city}|`));

  const total = units.length;
  const slice = units.slice((page - 1) * pageSize, page * pageSize);
  const source = klass === "newly-raised" ? foldedB : foldedA;

  const rows = slice.map((unit) => {
    const [c, direction, barcode] = unit.split("|");
    const d = byUnit.get(unit);
    const fullKey = source.keyOfUnit.get(unit) ?? "";
    const nameFromKey = fullKey.split("|").slice(3).join("|") || null;
    // A cleared unit whose row was deleted has a name but no bucket and no note,
    // and labelFor without those cannot apply the CLEARED_ON_RECHECK override —
    // so it gets no tier badge rather than a plausible wrong one.
    const label = d
      ? labelFor(d.variance_name, {
          direction: d.direction as "IN" | "OUT" | "CROSS" | null,
          jobType: d.job_type,
          bucket: d.bucket as "REAL" | "INFO" | null,
          note: d.note,
        })
      : null;
    return {
      key: unit,
      city: c,
      direction,
      barcode,
      rowPresent: !!d,
      problem: label?.display ?? nameFromKey,
      tier: label?.tier ?? null,
      action: label?.action ?? null,
      status: d?.status ?? null,
      ticketId: d?.ticket_id ?? null,
      soNumber: d?.so_number ?? null,
      product: d?.product ?? null,
      customer: d?.customer ?? null,
      reason: klass === "cleared" ? reasonFor(unit, foldedB, closedUnits) : null,
    };
  });

  return NextResponse.json({ total, page, pageSize, rows, degraded: "none" });
}
