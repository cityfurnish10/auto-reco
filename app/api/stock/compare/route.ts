// GET /api/stock/compare?date=&a=&b=
//
// What changed between two runs of one business date — and, more importantly,
// whether it is honest to say anything changed at all.
//
// Every figure the coverage guard blocks is nulled HERE, not in a component, so
// there is exactly one place that decides whether a number is publishable. `null`
// renders as an em dash; `0` renders as zero.
//
// Keys never reach the browser from this route: it returns counts. Unit detail is
// /api/stock/units, paginated.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { readRuns, readSnapshots, readVariances } from "@/lib/stock/db";
import { toPasses, type PassRef } from "@/lib/stock/passes";
import { foldPass, parseSnapshotRow } from "@/lib/stock/snapshot";
import { attributeCleared, diffPasses, suppressUntrustworthy } from "@/lib/stock/compare";
import { assessComparability } from "@/lib/stock/coverage";
import { classifyRows } from "@/lib/email/followup/compare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const me = await getCurrentAppUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const q = req.nextUrl.searchParams;
  const date = (q.get("date") ?? "").trim();
  if (!DATE_RE.test(date)) {
    return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }

  const db = createAdminClient();
  let runs, snapRows, variances;
  try {
    [runs, snapRows, variances] = await Promise.all([
      readRuns(db, date),
      readSnapshots(db, date),
      readVariances(db, date),
    ]);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }

  const { passes } = toPasses(runs);
  const parsed = (snapRows ?? []).map(parseSnapshotRow).filter((s) => s !== null);
  const byRun = new Map<string, typeof parsed>();
  for (const s of parsed) {
    const list = byRun.get(s!.runId) ?? [];
    list.push(s);
    byRun.set(s!.runId, list);
  }
  for (const p of passes) p.hasSnapshot = byRun.has(p.runId);

  const unavailable = (note: string) =>
    NextResponse.json({
      date,
      a: null,
      b: null,
      degraded: "unavailable",
      degradedNote: note,
      comparability: null,
      totals: null,
      cities: [],
    });

  if (snapRows === null) {
    return unavailable(
      "Per-run history was not recorded for this day, so the two checks cannot be compared."
    );
  }

  // Resolve the pair. Explicit ids win; otherwise the earliest snapshotted pass
  // against the latest one after it.
  const eligible = passes.filter((p) => p.hasSnapshot && !p.preClose);
  const pick = (id: string | null): PassRef | undefined =>
    id ? passes.find((p) => p.runId === id) : undefined;
  let a = pick(q.get("a")) ?? eligible[0];
  let b =
    pick(q.get("b")) ??
    [...eligible].reverse().find((p) => a && p.lagDays > a.lagDays);

  if (!a || !b || a.runId === b.runId) {
    return unavailable(
      "Only one check has run for this day, so there is nothing to compare it against."
    );
  }
  // An unambiguous intent expressed backwards is honoured, not rejected.
  let swapped = false;
  if (a.completedAt > b.completedAt) {
    [a, b] = [b, a];
    swapped = true;
  }
  if (!byRun.has(a.runId) || !byRun.has(b.runId)) {
    return unavailable("One of these checks did not record what it found, so there is nothing to compare.");
  }

  const foldedA = foldPass(a.runId, date, byRun.get(a.runId)!.map((s) => s!));
  const foldedB = foldPass(b.runId, date, byRun.get(b.runId)!.map((s) => s!));

  const guard = assessComparability(foldedA, foldedB, date);
  const delta = diffPasses(foldedA, foldedB);

  // Human action vs system self-resolution, which is the split this page exists to
  // show and the email deliberately collapses. Read from live variances because
  // "who closed it" is a workflow fact, not an engine one.
  const closedUnits = new Set(classifyRows(variances).closed.keys());
  const clearedUnits: string[] = [];
  for (const u of foldedA.flaggedUnits) if (!foldedB.flaggedUnits.has(u)) clearedUnits.push(u);
  delta.attribution = attributeCleared(clearedUnits, foldedB, closedUnits);

  const totals = suppressUntrustworthy(delta, guard);

  return NextResponse.json({
    date,
    a,
    b,
    swapped,
    degraded: "none",
    degradedNote: null,
    comparability: guard,
    totals,
    cities: totals.cities,
  });
}
