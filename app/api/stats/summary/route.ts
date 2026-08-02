// GET /api/stats/summary — dashboard KPI aggregates, replacing the hardcoded
// OVERALL / CITY_SUMMARIES sample data.
//
// Query params: date (business_date, default today). If no run exists for
// that exact date yet, falls back to the latest available run so the
// dashboard isn't empty before today's pipeline has fired.
//
// IMPORTANT: aggregates are computed from the `variances` table via the
// RLS-scoped server client — NOT from reconciliation_runs.combined (which is
// global across all cities). This is what keeps a manager's summary limited
// to their own city instead of leaking other cities' totals.

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { PENDING_LIST_REASON } from "@/lib/ui/closure-reasons";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

interface CityAgg {
  city: string;
  total: number;
  open: number;
  inProgress: number;
  pendingApproval: number;
  closed: number;
  // Subset of `closed` parked on the Pending List rather than finished.
  // Broken out so the Resolved tile can stop overstating completed work.
  pendingList: number;
  /**
   * The same four statuses, counted over LOSSES ONLY.
   *
   * Every KPI tile on the dashboard opens a list filtered to `bucket: "REAL"`,
   * but only `openReal` was counted that way — so "Closed today: 88" opened a
   * list of 31, and "12 pending approval" opened a list of 4. The tile that
   * shows `closed` even carries a comment conceding it cannot be related to
   * anything because the two count different universes.
   *
   * INFO-bucket rows are late Odoo postings, barcode typos and paperwork
   * written a day either side; they are settled in bulk and would dominate any
   * count of "what got dealt with". They keep their own line under the tiles.
   */
  openReal: number;
  inProgressReal: number;
  pendingApprovalReal: number;
  closedReal: number;
  pendingListReal: number;
  high: number;
  medium: number;
  info: number;
  real: number;
  infoBucket: number;
  ppBox: number; // count-only PP-box movements for the run (from run_city_stats)
  consumable: number; // count-only spare/consumable movements for the run
  /**
   * Distinct directional movements for the day — THE denominator.
   *
   * Every other page already uses it (the leaderboard and analytics both rank on
   * it), and it was being read one column away from here and discarded. Without
   * it a big warehouse always looks worse than a small one: Delhi with 18 gaps
   * in 1,204 movements reads worse than Pune with 12 in 180, when Pune is four
   * times worse per unit.
   */
  movements: number;
  /** Open losses first seen more than three days ago. */
  openOver3d: number;
  /** ISO timestamp of the oldest open loss, or null when none are open. */
  oldestOpenAt: string | null;
  /**
   * Movements ONLY Odoo saw — no gate register, no ops sheet, no delivery app.
   *
   * Measured 2026-07-29: Mumbai 123 of 172. Nothing on any screen said so, and
   * without it a reader assumes a movement was witnessed on the floor.
   */
  odooOnly: number;
  /**
   * Movements the floor recorded that Odoo has NOT posted.
   *
   * The dominant story on most days and the opposite of the one above: Pune 33
   * of 33 and Hyderabad 29 of 31 on 2026-07-29. Those are a posting backlog, not
   * missing stock, and the D+3 re-check usually clears them.
   */
  floorNotInOdoo: number;
  /** Movement rows found in the ledger for this date. 0 = ledger has no view. */
  ledgered: number;
}

function emptyAgg(city: string): CityAgg {
  return {
    city,
    total: 0,
    open: 0,
    inProgress: 0,
    pendingApproval: 0,
    closed: 0,
    pendingList: 0,
    openReal: 0,
    inProgressReal: 0,
    pendingApprovalReal: 0,
    closedReal: 0,
    pendingListReal: 0,
    high: 0,
    medium: 0,
    info: 0,
    real: 0,
    infoBucket: 0,
    ppBox: 0,
    consumable: 0,
    movements: 0,
    openOver3d: 0,
    oldestOpenAt: null,
    odooOnly: 0,
    floorNotInOdoo: 0,
    ledgered: 0,
  };
}

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const requestedDate = req.nextUrl.searchParams.get("date") || todayISO();

  // Latest run for the requested date …
  const { data: runsForDate, error: runErr } = await supabase
    .from("reconciliation_runs")
    .select("*")
    .eq("business_date", requestedDate)
    .in("status", ["success", "partial"])
    .order("created_at", { ascending: false })
    .limit(1);
  if (runErr) return NextResponse.json({ error: runErr.message }, { status: 500 });

  let run = runsForDate?.[0] ?? null;
  let usedFallbackRun = false;

  // … or fall back to the latest run overall. Ordered by business_date first:
  // ordering by created_at alone picked the *most recently executed* run, which
  // is routinely a re-check pass over an older day — so the dashboard would
  // silently report D-3 while /api/variances resolved D-1.
  if (!run) {
    const { data: latestRuns, error: latestErr } = await supabase
      .from("reconciliation_runs")
      .select("*")
      .in("status", ["success", "partial"])
      .order("business_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1);
    if (latestErr) return NextResponse.json({ error: latestErr.message }, { status: 500 });
    run = latestRuns?.[0] ?? null;
    usedFallbackRun = !!run;
  }

  if (!run) {
    return NextResponse.json({
      run: null,
      usedFallbackRun: false,
      byCity: [],
      overall: emptyAgg("ALL"),
    });
  }

  interface VarianceRow {
    city: string;
    status: string;
    priority: string;
    bucket: string;
    closure_reason: string | null;
    /**
     * Never reset by a re-run — persist.ts omits it from the upsert payload —
     * so `now - first_seen_at` is a real age, not "when we last looked".
     */
    first_seen_at: string | null;
  }
  interface LedgerRow {
    city: string;
    present_p: boolean;
    present_s: boolean;
    present_d: boolean;
    present_o: boolean;
    is_movement: boolean;
  }

  // THE FOUR READS BELOW RUN CONCURRENTLY.
  //
  // They are independent — each needs only `run`, none needs another's result —
  // and they used to be four sequential awaits. Measured on 2026-07-31 (817
  // variances, 1,828 ledger rows): 1218 + 1350 + 368 + 381 ms, so the dashboard
  // spent about 3.3s waiting on round trips that could have overlapped. Nothing
  // about WHAT is read or how it is aggregated changes here; only when it
  // arrives. Each keeps its own failure behaviour: variances is fatal, the
  // ledger and the calendar are swallowed, city stats ignores its error exactly
  // as before.
  //
  // Paging stays sequential WITHIN a read — page N+1's offset depends on page N
  // coming back short — and PostgREST silently caps an un-ranged select at 1000
  // rows, which once made the KPI cards truncate a large run (2026-07-21: 1578
  // rows → the cards showed the first 1000).
  const readVariances = async (): Promise<{ rows: VarianceRow[]; error: string | null }> => {
    const rows: VarianceRow[] = [];
    for (let from = 0; ; from += 1000) {
      const { data: page, error } = await supabase
        .from("variances")
        .select("city, status, priority, bucket, closure_reason, first_seen_at")
        // BY DATE, NOT BY RUN — the scope every other reader of this table
        // already uses (/api/variances:130, facets, the CSV export, the pending
        // list, lib/stock/db.ts). The tiles used to scope by run_id, so the
        // moment a row's run_id stopped being re-stamped it fell out of the
        // KPIs while staying in the table directly beneath them. Rows go stale
        // that way routinely: upsertVariances only re-stamps keys the newest
        // run RE-EMITS, human-touched rows are deliberately left alone, and the
        // D-3 re-check pass legitimately emits less than the primary run did.
        //
        // Measured 2026-08-02 over the six most recent days, every one of them
        // divergent: 26 Jul 719 vs 841, 30 Jul 412 vs 501, 31 Jul 817 vs 885.
        // The tile said 719 and the table it opened listed 841.
        //
        // Cannot double-count: variances is UNIQUE (business_date, city,
        // direction, barcode, variance_name) (0001_init.sql:158) and superseded
        // rows are hard-DELETEd (persist.ts:359), so one day has at most one
        // row per key. It also puts the numerator on the same footing as
        // `movements` below, which this route already reads by business_date.
        .eq("business_date", run.business_date)
        // Deterministic order — unordered .range() pages can repeat/skip rows.
        .order("id", { ascending: true })
        .range(from, from + 999);
      if (error) return { rows, error: error.message };
      rows.push(...((page ?? []) as VarianceRow[]));
      if (!page || page.length < 1000) break;
    }
    return { rows, error: null };
  };

  const readLedger = async (): Promise<LedgerRow[] | null> => {
    try {
      const rows: LedgerRow[] = [];
      for (let from = 0; ; from += 1000) {
        const { data: page, error } = await supabase
          .from("movement_events")
          .select("city, present_p, present_s, present_d, present_o, is_movement")
          .eq("business_date", run.business_date)
          // Latest run only — the ledger never deletes, so rows the newest run no
          // longer emits (merged/parked OCR artifacts) linger under older run_ids
          // and inflated these counts. run.id IS that date's latest run here.
          .eq("run_id", run.id)
          .order("id", { ascending: true })
          .range(from, from + 999);
        if (error) throw error;
        rows.push(...((page ?? []) as LedgerRow[]));
        if (!page || page.length < 1000) break;
      }
      return rows;
    } catch {
      return null; // ledger unavailable — the source story is simply not shown
    }
  };

  const readCalendar = async () => {
    try {
      const { data, error } = await supabase
        .from("warehouse_calendar")
        .select("city, weekday, holiday_date");
      return error ? null : data;
    } catch {
      return null; // pre-0019 database — the clients use the hardcoded map
    }
  };

  const [varRes, cityStatsRes, ledgerRows, calRows] = await Promise.all([
    readVariances(),
    supabase
      .from("run_city_stats")
      .select("city, pp_box_count, consumable_count, movements")
      .eq("business_date", run.business_date),
    readLedger(),
    readCalendar(),
  ]);

  if (varRes.error) return NextResponse.json({ error: varRes.error }, { status: 500 });
  const variances = varRes.rows;
  const cityStats = cityStatsRes.data;

  const byCityMap = new Map<string, CityAgg>();
  const overall = emptyAgg("ALL");
  const threeDaysAgo = Date.now() - 3 * 86400_000;

  for (const v of variances ?? []) {
    const agg = byCityMap.get(v.city) ?? emptyAgg(v.city);
    for (const target of [agg, overall]) {
      const isReal = v.bucket === "REAL";
      const onPendingList = v.closure_reason === PENDING_LIST_REASON;
      target.total += 1;
      if (v.status === "open") target.open += 1;
      else if (v.status === "in_progress") target.inProgress += 1;
      else if (v.status === "pending_approval") target.pendingApproval += 1;
      else if (v.status === "closed") {
        target.closed += 1;
        if (onPendingList) target.pendingList += 1;
      }
      // The loss-only mirror of the four above. Every tile that opens a list
      // filters to REAL, so every tile's NUMBER has to be counted that way too.
      if (isReal) {
        if (v.status === "in_progress") target.inProgressReal += 1;
        else if (v.status === "pending_approval") target.pendingApprovalReal += 1;
        else if (v.status === "closed") {
          target.closedReal += 1;
          if (onPendingList) target.pendingListReal += 1;
        }
      }
      if (v.priority === "High") target.high += 1;
      else if (v.priority === "Medium") target.medium += 1;
      else if (v.priority === "Info") target.info += 1;
      if (isReal) target.real += 1;
      else if (v.bucket === "INFO") target.infoBucket += 1;
      if (v.status === "open" && isReal) {
        target.openReal += 1;
        // How long the queue has been waiting. A bare "Open: 23" cannot say
        // whether those 23 arrived this afternoon or have been sitting a week,
        // which is the first thing an owner asks about a backlog.
        const seen = v.first_seen_at ? Date.parse(v.first_seen_at) : NaN;
        if (Number.isFinite(seen)) {
          if (seen < threeDaysAgo) target.openOver3d += 1;
          if (target.oldestOpenAt === null || seen < Date.parse(target.oldestOpenAt)) {
            target.oldestOpenAt = v.first_seen_at;
          }
        }
      }
    }
    byCityMap.set(v.city, agg);
  }

  // Overlay count-only PP-box / consumable movements from run_city_stats for
  // this run's date (RLS-scoped: a manager sees only their own city's row).
  for (const s of cityStats ?? []) {
    const agg = byCityMap.get(s.city) ?? emptyAgg(s.city);
    agg.ppBox = s.pp_box_count ?? 0;
    agg.consumable = s.consumable_count ?? 0;
    // The denominator. It was being fetched one column away from here and
    // thrown out, which is why five city cards ranked by warehouse size.
    agg.movements = s.movements ?? 0;
    byCityMap.set(s.city, agg);
    overall.ppBox += s.pp_box_count ?? 0;
    overall.consumable += s.consumable_count ?? 0;
    overall.movements += s.movements ?? 0;
  }

  // Which sources actually witnessed each movement (migration 0015). Null when
  // 0015 is not applied: the counts stay 0 and the UI says nothing rather than
  // guessing.
  for (const m of ledgerRows ?? []) {
    if (!m.is_movement) continue;
    const agg = byCityMap.get(m.city) ?? emptyAgg(m.city);
    const floor = m.present_p || m.present_s || m.present_d;
    agg.ledgered += 1;
    overall.ledgered += 1;
    if (m.present_o && !floor) {
      agg.odooOnly += 1;
      overall.odooOnly += 1;
    } else if (floor && !m.present_o) {
      agg.floorNotInOdoo += 1;
      overall.floorNotInOdoo += 1;
    }
    byCityMap.set(m.city, agg);
  }

  // The closure calendar (migration 0019), mirrored from the delivery app by
  // the reconcile pipeline. RLS grants SELECT to any signed-in user. Null when
  // the table is absent or empty — the dashboards then fall back to the
  // hardcoded WEEKLY_OFF_DAY map, exactly like the email builder does.
  let calendar: {
    weeklyOff: Record<string, number[]>;
    holidays: Record<string, string[]>;
  } | null = null;
  if (calRows && calRows.length > 0) {
    const weeklyOff: Record<string, number[]> = {};
    const holidays: Record<string, string[]> = {};
    for (const r of calRows as { city: string; weekday: number | null; holiday_date: string | null }[]) {
      if (r.weekday !== null && r.weekday !== undefined) (weeklyOff[r.city] ??= []).push(r.weekday);
      else if (r.holiday_date) (holidays[r.city] ??= []).push(r.holiday_date);
    }
    calendar = { weeklyOff, holidays };
  }

  return NextResponse.json({
    run: {
      id: run.id,
      business_date: run.business_date,
      run_date: run.run_date,
      status: run.status,
      created_at: run.created_at,
      completed_at: run.completed_at,
    },
    usedFallbackRun,
    calendar,
    byCity: [...byCityMap.values()].sort((a, b) => a.city.localeCompare(b.city)),
    overall,
  });
}
