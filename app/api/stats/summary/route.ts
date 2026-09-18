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
import { jsonRoute } from "@/lib/api/json-route";
import { createClient } from "@/lib/supabase/server";
import { PENDING_LIST_REASON } from "@/lib/ui/closure-reasons";
import { usesCalendarDay } from "@/lib/connectors/ist-window";
import { isCityClosed } from "@/lib/engine/schedule";
import { addDays } from "@/lib/engine/dates";
import type { City } from "@/lib/sample-data";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * What ONE source recorded for this city and day, per direction.
 *
 * `reported` is not derivable from the counts and is the whole reason this is a
 * shape rather than two numbers: a source that was down and a source that saw a
 * genuinely quiet gate both count 0, and the dashboard must never draw the
 * first one as if it were the second (invariant 2).
 */
export interface SourceCount {
  in: number;
  out: number;
  reported: boolean;
  /**
   * Rows this source itself said did not happen, and were therefore left out
   * of the counts beside them (migration 0048). Only the sheet carries an
   * outcome, so only the sheet ever has these.
   */
  notDone?: { in: number; out: number };
  /**
   * ALL CITIES only: the cities this source did not report for. A "Partial"
   * badge that makes the reader open five tabs to find out which is a badge
   * that does not get read.
   */
  missing?: string[];
}

type TruthSource = "gate" | "sheet" | "dt" | "odoo";
interface TruthCounts {
  /** Units this book has. */
  saw: number;
  /** …of which every other book has too. */
  allMatched: number;
  /** …matched / not matched by each other book. */
  vs: Partial<Record<TruthSource, { matched: number; notMatched: number }>>;
}
const TRUTH_SOURCES: TruthSource[] = ["gate", "sheet", "dt", "odoo"];
const emptyTruth = (): Record<TruthSource, Record<"IN" | "OUT", TruthCounts>> => {
  const one = (): TruthCounts => ({ saw: 0, allMatched: 0, vs: {} });
  const out = {} as Record<TruthSource, Record<"IN" | "OUT", TruthCounts>>;
  for (const s of TRUTH_SOURCES) out[s] = { IN: one(), OUT: one() };
  return out;
};

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
  /**
   * What each of the four books recorded, per direction (migration 0012).
   *
   * The engine has computed these on every run since 0012 and only the digest
   * email ever read them. They are the answer to the first question anybody
   * asks of a reconciliation — "do the four counts even agree?" — which the
   * variance list can only answer one unit at a time.
   */
  sources: {
    gate: SourceCount;
    sheet: SourceCount;
    dt: SourceCount;
    odoo: SourceCount;
  };
  /**
   * Counted extras the GATE recorded — spare parts, consumables, PP boxes,
   * samples. Read live from gate_scans, not from the run.
   *
   * They cannot come from the run: lib/connectors/guard.ts drops every
   * barcode-less row before the engine sees it (a row with no serial cannot
   * enter a per-barcode ladder), so a guard's hand-added items have never
   * reached any screen in this tool. Reading them here also means they appear
   * for a day no reconciliation has run for yet.
   */
  gateCount: { in: number; out: number; items: number };
  /**
   * The day read with the GATE as the anchor (decided 15 Sep 2026).
   *
   * The guard is the only source physically present when goods cross, so where
   * it has a record that record stands and every other book is checked against
   * it. Its SILENCE is deliberately not treated the same way: measured that
   * week, Delhi's gate witnessed 26%, 42% then 60% of each day's movements as
   * coverage improved, and on 13 Sep there were 118 movements the other three
   * books all agreed on with nothing at the gate. Blaming three correct books
   * for the guard's absence is the failure this shape exists to avoid — so
   * `notSeenByGate` is a group of its own, never a variance count.
   */
  /**
   * Each book in turn as the source of truth (owner's design, 18 Sep 2026):
   * of the units THIS book has, how many all four agree on, and how many each
   * of the other three matches. Units, per direction, from the movement ledger.
   * Odoo is counted on its own 3pm window (odoo_same_day), the same rule as the
   * scoreboard's Odoo column, so a card's denominator ties to that table.
   */
  truth: Record<TruthSource, Record<"IN" | "OUT", TruthCounts>>;
  /** When Odoo's window for this day closes (ISO), or null on a 15:00-rule day. */
  odooWindowEnd: string | null;
  anchored: {
    /** Movements the gate witnessed — the denominator of the three below. */
    gateSaw: number;
    /** Gate saw it and all three other books agree. */
    confirmedAll: number;
    /** Gate saw it; this book has no record of it. */
    gateNotOdoo: number;
    gateNotSheet: number;
    gateNotDt: number;
    /** Some book recorded a movement the gate has nothing for. Not blame. */
    notSeenByGate: number;
    /** False = the gate did not report at all; every figure above is unknown. */
    gateReported: boolean;
  };
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
    sources: {
      gate: { in: 0, out: 0, reported: false },
      sheet: { in: 0, out: 0, reported: false },
      dt: { in: 0, out: 0, reported: false },
      odoo: { in: 0, out: 0, reported: false },
    },
    gateCount: { in: 0, out: 0, items: 0 },
    truth: emptyTruth(),
    odooWindowEnd: null,
    anchored: {
      gateSaw: 0, confirmedAll: 0, gateNotOdoo: 0, gateNotSheet: 0,
      gateNotDt: 0, notSeenByGate: 0, gateReported: false,
    },
  };
}

/** The counted family — no serial exists or is expected (migration 0041). */
const COUNTED_KINDS = ["spare_part", "consumable", "pp_box", "sample"] as const;

export const GET = jsonRoute("stats/summary", async (req: NextRequest) => {
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
    /** The gate reported at all for this city and day (invariant 2). */
    reported_p: boolean;
    direction: "IN" | "OUT";
    /** Odoo posted it inside this day's own 3pm window — the scoreboard's Odoo. */
    odoo_same_day: boolean;
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
          .select("city, present_p, present_s, present_d, present_o, is_movement, reported_p, direction, odoo_same_day")
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

  // Counted extras straight from the gate. Its own try/catch: these columns
  // arrived with the gate app and an older database simply has no rows, which
  // must cost the card its numbers and nothing else on the page.
  const readGateCounts = async () => {
    try {
      const { data, error } = await supabase
        .from("gate_scans")
        .select("city, direction, quantity")
        .eq("business_date", run.business_date)
        .eq("status", "recorded")
        .in("item_kind", COUNTED_KINDS as unknown as string[])
        .is("barcode", null)
        .limit(2000);
      return error ? null : data;
    } catch {
      return null;
    }
  };

  // The 0048 columns first, then without them. Migrations are applied by hand
  // (trap 3), and on 18 Sep 2026 an unapplied 0048 made this whole read fail —
  // every source on the scoreboard fell back to "No data" for every city,
  // because one breakdown column did not exist yet. The breakdown is a nicety;
  // the counts beside it are not.
  const readCityStats = async () => {
    const full = await supabase
      .from("run_city_stats")
      // One literal, however long: PostgREST infers the row type from the
      // string, and a concatenated one degrades every column to `unknown`.
      .select("city, pp_box_count, consumable_count, movements, phys_in, phys_out, sheet_in, sheet_out, dt_in, dt_out, odoo_in, odoo_out, reported_p, reported_s, reported_d, reported_o, sheet_dropped_in, sheet_dropped_out")
      .eq("business_date", run.business_date);
    if (!full.error) return full;
    const base = await supabase
      .from("run_city_stats")
      .select("city, pp_box_count, consumable_count, movements, phys_in, phys_out, sheet_in, sheet_out, dt_in, dt_out, odoo_in, odoo_out, reported_p, reported_s, reported_d, reported_o")
      .eq("business_date", run.business_date);
    return base as unknown as typeof full;
  };

  const [varRes, cityStatsRes, ledgerRows, calRows, gateCountRows] = await Promise.all([
    readVariances(),
    readCityStats(),
    readLedger(),
    readCalendar(),
    readGateCounts(),
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
    agg.sources = {
      gate: { in: s.phys_in ?? 0, out: s.phys_out ?? 0, reported: !!s.reported_p },
      sheet: {
        in: s.sheet_in ?? 0, out: s.sheet_out ?? 0, reported: !!s.reported_s,
        // The rows the sheet said never happened. Shown so the figure beside
        // it can be reconciled against the sheet somebody is reading.
        notDone: { in: s.sheet_dropped_in ?? 0, out: s.sheet_dropped_out ?? 0 },
      },
      dt: { in: s.dt_in ?? 0, out: s.dt_out ?? 0, reported: !!s.reported_d },
      odoo: { in: s.odoo_in ?? 0, out: s.odoo_out ?? 0, reported: !!s.reported_o },
    };
    byCityMap.set(s.city, agg);
    overall.ppBox += s.pp_box_count ?? 0;
    overall.consumable += s.consumable_count ?? 0;
    overall.movements += s.movements ?? 0;
    // ALL CITIES sums the counts, but "reported" is an AND across the cities in
    // view: one gate down is the fact worth surfacing, and an OR would let four
    // healthy cities vouch for it.
    for (const k of ["gate", "sheet", "dt", "odoo"] as const) {
      const from = agg.sources[k];
      const to = overall.sources[k];
      to.in += from.in;
      to.out += from.out;
    }
  }
  // Only cities the run actually covered get a vote. A city that appears here
  // solely because it has an old open variance never ran today, and letting its
  // all-false row into the AND would report every source as down.
  const covered = (cityStats ?? []).map((s) => byCityMap.get(s.city)).filter((c): c is CityAgg => !!c);
  for (const k of ["gate", "sheet", "dt", "odoo"] as const) {
    overall.sources[k].reported = covered.length > 0 && covered.every((c) => c.sources[k].reported);
    overall.sources[k].missing = covered.filter((c) => !c.sources[k].reported).map((c) => c.city).sort();
  }

  // Counted extras per city — quantities, not rows: four PP boxes on one entry
  // is four boxes, and the guard's own screen says four.
  for (const g of (gateCountRows ?? []) as { city: string; direction: string; quantity: number | null }[]) {
    const agg = byCityMap.get(g.city) ?? emptyAgg(g.city);
    const qty = g.quantity ?? 1;
    for (const target of [agg, overall]) {
      if (g.direction === "IN") target.gateCount.in += qty;
      else target.gateCount.out += qty;
      target.gateCount.items += 1;
    }
    byCityMap.set(g.city, agg);
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

    // Each book as the source of truth, in turn.
    const has: Record<TruthSource, boolean> = {
      gate: m.present_p, sheet: m.present_s, dt: m.present_d, odoo: !!m.odoo_same_day,
    };
    const dir = m.direction === "IN" ? "IN" : "OUT";
    for (const target of [agg, overall]) {
      for (const src of TRUTH_SOURCES) {
        if (!has[src]) continue;
        const t = target.truth[src][dir];
        t.saw += 1;
        const others = TRUTH_SOURCES.filter((o) => o !== src);
        if (others.every((o) => has[o])) t.allMatched += 1;
        for (const o of others) {
          const v = (t.vs[o] ??= { matched: 0, notMatched: 0 });
          if (has[o]) v.matched += 1; else v.notMatched += 1;
        }
      }
    }

    // The same rows read with the gate as the anchor. Counted here rather than
    // in a second pass because this loop already walks every movement of the
    // day and the ledger is the only place the four presence flags live
    // together.
    for (const target of [agg, overall]) {
      const a = target.anchored;
      // One city reporting is enough for the ALL view to have something to
      // show; the per-city figure is the one that decides anything.
      if (m.reported_p) a.gateReported = true;
      if (m.present_p) {
        a.gateSaw += 1;
        if (m.present_o && m.present_s && m.present_d) a.confirmedAll += 1;
        if (!m.present_o) a.gateNotOdoo += 1;
        if (!m.present_s) a.gateNotSheet += 1;
        if (!m.present_d) a.gateNotDt += 1;
      } else {
        a.notSeenByGate += 1;
      }
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

  // WHEN ODOO'S WINDOW FOR THIS DAY CLOSES — 3pm on the next day the warehouse
  // opens (18 Sep 2026 rules). Before then Odoo's figure is still filling in,
  // and section 1 of the dashboard says so rather than letting a half-posted
  // day read as a finished one. Only for calendar-day runs; the old 15:00 days
  // closed on their own boundary.
  const windowEnd = (city: string): string | null => {
    const d0 = String(run.business_date).slice(0, 10);
    if (!usesCalendarDay(d0)) return null;
    let d = addDays(d0, 1);
    for (let i = 0; i < 7 && isCityClosed(city as City, d, calendar); i++) d = addDays(d, 1);
    return new Date(`${d}T15:00:00+05:30`).toISOString();
  };
  for (const agg of byCityMap.values()) agg.odooWindowEnd = windowEnd(agg.city);
  const ends = (cityStats ?? []).map((s) => windowEnd(s.city)).filter((e): e is string => !!e).sort();
  overall.odooWindowEnd = ends.length ? ends[ends.length - 1] : null;

  return NextResponse.json({
    run: {
      id: run.id,
      business_date: run.business_date,
      run_date: run.run_date,
      status: run.status,
      created_at: run.created_at,
      completed_at: run.completed_at,
      // What business_date meant for this run (0049). Stamped on every run
      // since the 13 Sep cutover and, until 18 Sep 2026, never passed on — so
      // the scoreboard fell back to "3pm to 3pm" on calendar days.
      day_definition: (run as { day_definition?: string }).day_definition ?? "business_15",
    },
    usedFallbackRun,
    calendar,
    byCity: [...byCityMap.values()].sort((a, b) => a.city.localeCompare(b.city)),
    overall,
  });
});
