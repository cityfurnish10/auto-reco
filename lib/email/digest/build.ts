// Builds DigestData from PERSISTED rows. Queries only — no copy, no markup.

import { flaggedKeyOf } from "../followup/snapshot";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isCityClosed,
  isCityOff,
  lastWorkingDay,
  registerDueOn,
} from "../../engine/schedule";
import { addDays } from "../../engine/dates";
import { buildTrends, type CoverageRow } from "./trends";
import { isRerunFresh } from "../followup/build";
import { readWarehouseCalendarRows } from "../../db/persist";
import { LOOKBACK_DAYS, summariseAgeing, type AgeingSummary } from "./ageing";
import {
  latestFullyCoveredDate,
  readFourWayCoverage,
  type FourWayCoverage,
} from "./coverage";
import { labelFor, teamFor, type Tier } from "../../ui/variance-labels";
import type { City } from "../../sample-data";
import type {
  ActionItem,
  CityDigestRow,
  DigestData,
  HandoverRow,
  RegisterState,
} from "./types";

/** How many reconciled business days the watch list looks back over. */
const WATCH_DAYS = 7;
/**
 * How far back the handover table will look for a city's last working day.
 *
 * Comfortably past a weekly off stacked against a public holiday, and bounded
 * so a misconfigured calendar cannot make this read the whole table.
 */
const HANDOVER_LOOKBACK_DAYS = 14;
/** A (label, city) pattern below this on the reporting day is noise. */
const WATCH_MIN_UNITS = 5;
/** Cities named inline on an action line before it collapses to "+N cities". */
const MAX_CITIES_INLINE = 2;

interface VarianceRow {
  city: string;
  status: string;
  variance_name: string;
  direction: string | null;
  job_type: string | null;
  // Read so labelFor can honour a post-classification downgrade: a row the
  // next-day re-check resolved must not head the owner's chase list.
  bucket: string | null;
  // Identity, for the follow-up snapshot only. Never rendered.
  barcode: string;
  // The resolved-late marker. Five of the six tier-2 names are natural INFO, so
  // for them this is the ONLY column that changes when a gap clears.
  note: string | null;
}

type CityStatRow = {
  city: string;
  movements: number | null;
  real_count: number | null;
  pp_box_count: number | null;
  sheet_in?: number | null; sheet_out?: number | null;
  odoo_in?: number | null; odoo_out?: number | null;
  dt_in?: number | null; dt_out?: number | null;
  phys_in?: number | null; phys_out?: number | null;
  reported_p?: boolean | null; reported_s?: boolean | null;
  reported_d?: boolean | null; reported_o?: boolean | null;
};

const labelOfRow = (r: VarianceRow) =>
  labelFor(r.variance_name, {
    direction: (r.direction as "IN" | "OUT" | "CROSS" | null) ?? null,
    jobType: r.job_type,
    bucket: (r.bucket as "REAL" | "INFO" | null) ?? null,
    note: r.note,
  });

const tierOfRow = (r: VarianceRow): Tier => labelOfRow(r).tier;

/** Latest successful run id for a date, or undefined. */
async function latestRunId(
  db: SupabaseClient,
  businessDate: string
): Promise<string | undefined> {
  // Scope to the LATEST successful run — variances retain every re-check pass
  // for a date, so a date-only filter double-counts (2026-07-21: the email said
  // "563 to action" while the run held 555).
  const { data } = await db
    .from("reconciliation_runs")
    .select("id")
    .eq("business_date", businessDate)
    .in("status", ["success", "partial"])
    .order("created_at", { ascending: false })
    .limit(1);
  return data?.[0]?.id as string | undefined;
}

/** Paginated read of one run's variance rows. */
async function readVariances(
  db: SupabaseClient,
  businessDate: string,
  runId: string | undefined
): Promise<VarianceRow[]> {
  const rows: VarianceRow[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db
      .from("variances")
      .select("city,status,variance_name,direction,job_type,bucket,barcode,note")
      .eq("business_date", businessDate);
    if (runId) q = q.eq("run_id", runId);
    // Deterministic order — unordered .range() pages can repeat or skip rows.
    const { data, error } = await q.order("id", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`buildDigestFromDb: ${error.message}`);
    rows.push(...((data ?? []) as VarianceRow[]));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

/**
 * Patterns repeating across recent days.
 *
 * Only `variances` can answer this — source_rows is pruned at 7 days. Every
 * comparison is scoped to one run per date for the same reason readVariances is.
 */
/**
 * Recent per-city history, for the trend verdicts.
 *
 * One read of roughly 4,000 labelled prior rows — the most expensive query in
 * the digest — so the counts come out of it rather than being read again.
 */
interface History {
  /** Tier-1 count per `${city}\0${date}`, today included. */
  tier1: Map<string, number>;
  /** Dates with a completed run, newest first, excluding today. */
  priorDates: string[];
  /** Items raised days ago and still not settled — the third section. */
  ageing: AgeingSummary;
}

/**
 * A date is only believable if it was reconciled again recently.
 *
 * resolveStaleOpenVariances — the thing that notices an item cleared — runs only
 * when a date is re-run, so "still open" on a date last touched four days ago is
 * a statement about our records, not about the floor. The pg_cron sweep
 * (migration 0018) re-runs D-2 .. D-7 at 15:50 IST, an hour before this email,
 * so a swept date's newest run is minutes old.
 */
const FRESH_WITHIN_MS = 24 * 3600_000;

async function buildWatchList(
  db: SupabaseClient,
  businessDate: string,
  todayRows: VarianceRow[]
): Promise<History> {
  // One day wider than the trend window: the ageing list looks back
  // LOOKBACK_DAYS from the reported date, so its oldest day is D-7. The trend
  // verdicts simply get one more day of baseline, which is strictly better.
  const start = addDays(businessDate, -Math.max(WATCH_DAYS - 1, LOOKBACK_DAYS));
  const { data: runs } = await db
    .from("reconciliation_runs")
    // status/completed_at feed the freshness gate below — isRerunFresh needs both.
    .select("id, business_date, created_at, completed_at, status")
    .gte("business_date", start)
    .lt("business_date", businessDate)
    .in("status", ["success", "partial"])
    .order("business_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(200);

  // One id per date — the ordering above puts each date's latest run first.
  const runIdByDate = new Map<string, string>();
  for (const r of runs ?? []) {
    const d = r.business_date as string;
    if (!runIdByDate.has(d)) runIdByDate.set(d, r.id as string);
  }
  const runIds = [...runIdByDate.values()];
  const noAgeing: AgeingSummary = { cities: [], total: 0, atRisk: 0, toFix: 0, overAWeek: 0, staleDates: [],
    grid: { dates: [], rows: [], dailyTotals: [], grandTotal: 0 } };
  const empty: History = { tier1: new Map(), priorDates: [], ageing: noAgeing };
  if (runIds.length < 2) return empty;

  // Which dates were re-reconciled recently enough that "still open" is a claim
  // about the floor rather than about the age of our last look. Grouped from the
  // runs already fetched — no extra query — and decided by the follow-up's own
  // isRerunFresh so there is exactly one definition of "re-run since".
  const runsByDate = new Map<string, { status: string; completed_at: string | null }[]>();
  for (const r of runs ?? []) {
    const d = r.business_date as string;
    const list = runsByDate.get(d) ?? [];
    list.push({ status: r.status as string, completed_at: (r.completed_at as string) ?? null });
    runsByDate.set(d, list);
  }
  const freshSince = new Date(Date.now() - FRESH_WITHIN_MS).toISOString();
  const freshDates = new Set<string>();
  for (const [d, list] of runsByDate) {
    if (isRerunFresh(list, freshSince).fresh) freshDates.add(d);
  }

  const prior: (VarianceRow & { business_date: string })[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("variances")
      .select("city,status,variance_name,direction,job_type,bucket,barcode,note,business_date")
      .in("run_id", runIds)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    prior.push(...((data ?? []) as (VarianceRow & { business_date: string })[]));
    if (!data || data.length < 1000) break;
  }

  // Tier 1 only, per city per date — the quantity the "At risk" column shows, so
  // the trend beside it compares like with like. Counted as-found regardless of
  // status, exactly as the watch tally is: closing an item does not mean the
  // pattern did not happen that day.
  // A separator that cannot occur in a city name. Written as an ESCAPE, never a
  // literal byte: a raw NUL makes git treat this file as binary — no diff, no
  // blame — which has bitten this exact file more than once.
  const SEP = "\u0000";
  const key = (city: string, date: string) => `${city}${SEP}${date}`;
  const tier1 = new Map<string, number>();
  const bump = (city: string, date: string) =>
    tier1.set(key(city, date), (tier1.get(key(city, date)) ?? 0) + 1);

  for (const r of prior) {
    const l = labelOfRow(r);
    if (l.tier === 1 && !isCityOff(r.city as City, r.business_date)) {
      bump(r.city, r.business_date);
    }
  }
  // TODAY's rows are filtered for weekly-off exactly as the prior days are.
  //
  // Without this a shut warehouse reports zero of everything and falls straight
  // into the "cleared" branch below (today === 0 && median >= WATCH_MIN_UNITS),
  // so the Thursday digest congratulates a city for a pattern that stopped only
  // because nobody was there. The real 23 July email carried "Register Gap, Pune
  // — clear today after 3 straight days" for a warehouse that was closed.
  //
  // The tier-1 bump is skipped for the same reason: a structural zero must not
  // become a data point in that city's own baseline.
  for (const r of todayRows) {
    if (isCityOff(r.city as City, businessDate)) continue;
    if (labelOfRow(r).tier === 1) bump(r.city, businessDate);
  }

  const priorDates = [...runIdByDate.keys()].sort().reverse();
  // Same rows, second question. `prior` is already scoped to one run per date
  // and read in a deterministic id order, which is exactly what summariseAgeing
  // needs — so the third section costs no additional query.
  const ageing = summariseAgeing(prior, businessDate, freshDates);
  return { tier1, priorDates, ageing };
}

export async function buildDigestFromDb(
  db: SupabaseClient,
  businessDate: string
): Promise<DigestData> {
  const runId = await latestRunId(db, businessDate);
  const rows = await readVariances(db, businessDate, runId);

  // Per-city movement counts. Try the 0012 columns; on 42703 fall back to the
  // legacy set so an unapplied migration omits the counts rather than failing.
  let stats: CityStatRow[] = [];
  let hasCounts = true;
  {
    const full = await db
      .from("run_city_stats")
      .select(
        "city, movements, real_count, pp_box_count, sheet_in, sheet_out, odoo_in, odoo_out, dt_in, dt_out, phys_in, phys_out, reported_p, reported_s, reported_d, reported_o"
      )
      .eq("business_date", businessDate);
    if (full.error) {
      hasCounts = false;
      const legacy = await db
        .from("run_city_stats")
        .select("city, movements, real_count, pp_box_count")
        .eq("business_date", businessDate);
      stats = (legacy.data ?? []) as CityStatRow[];
    } else {
      stats = (full.data ?? []) as CityStatRow[];
    }
  }
  const statByCity = new Map(stats.map((s) => [s.city, s]));

  // A WINDOW, not a single date. The reported day's own uploads drive
  // registerOf() below, but the handover table asks about each city's OWN last
  // working day, which is an earlier date for any city shut since — and on a
  // Friday that is three of the five. One read serves both.
  const { data: uploads } = await db
    .from("guard_uploads")
    .select("city, status, business_date")
    .gte("business_date", addDays(businessDate, -HANDOVER_LOOKBACK_DAYS))
    .lte("business_date", businessDate);
  const uploadByCity = new Map<string, string[]>();
  const uploadByCityDate = new Map<string, string[]>();
  for (const u of uploads ?? []) {
    const city = u.city as string;
    const date = u.business_date as string;
    const keyed = uploadByCityDate.get(`${city}|${date}`) ?? [];
    keyed.push(u.status as string);
    uploadByCityDate.set(`${city}|${date}`, keyed);
    if (date !== businessDate) continue;
    const list = uploadByCity.get(city) ?? [];
    list.push(u.status as string);
    uploadByCity.set(city, list);
  }

  const byCity = new Map<string, VarianceRow[]>();
  for (const r of rows) {
    if (!byCity.has(r.city)) byCity.set(r.city, []);
    byCity.get(r.city)!.push(r);
  }
  for (const s of stats) if (!byCity.has(s.city)) byCity.set(s.city, []);

  // The closure calendar, mirrored from the delivery app by the reconcile
  // pipeline (migration 0019). Read BEFORE registerOf so the register column,
  // the week-off badge and the handover table all judge closures from the same
  // source — with two of them on the calendar and one on the hardcoded map, a
  // public holiday made one email contradict itself. Null is a first-class
  // answer: every consumer falls back to WEEKLY_OFF_DAY.
  const calendar = await readWarehouseCalendarRows(db).catch(() => null);

  const registerOf = (city: string): RegisterState => {
    if (isCityClosed(city as City, businessDate, calendar)) return "off";
    const statuses = uploadByCity.get(city) ?? [];
    // No upload, and this board's register is not even DUE tomorrow: the city
    // is shut in between (weekly off or holiday), so the book is handed over
    // on its next working day. Wednesday's book from a Thursday-off warehouse
    // arrives Friday, and the Friday sweep folds it in. An alarm before the
    // due date would cry wolf every single week, on schedule.
    if (statuses.length === 0) {
      const due = registerDueOn(city as City, businessDate, calendar);
      if (due !== null && due !== addDays(businessDate, 1)) return "delayed";
      return "missing";
    }
    if (statuses.includes("processed")) return "received";
    if (statuses.includes("failed")) return "failed";
    return "pending"; // pending / ocr_running / needs_review
  };

  const cities: CityDigestRow[] = [];
  for (const [city, cr] of byCity) {
    const open = cr.filter((v) => v.status !== "closed");
    const t = (n: Tier) => open.filter((v) => tierOfRow(v) === n).length;
    const st = statByCity.get(city);

    // Largest tier-1 kind for this city.
    const t1 = open.filter((v) => tierOfRow(v) === 1);
    const tally = new Map<string, { count: number; name: string }>();
    for (const v of t1) {
      const d = labelOfRow(v).display;
      const cur = tally.get(d) ?? { count: 0, name: v.variance_name };
      cur.count++;
      tally.set(d, cur);
    }
    const top = [...tally.entries()].sort((a, b) => b[1].count - a[1].count)[0];

    cities.push({
      city,
      movements: Number(st?.movements ?? 0),
      tier1: t(1),
      tier2: t(2),
      tier3: t(3),
      open: open.length,
      register: registerOf(city),
      // ONE business date per week, not two.
      //
      // A holiday lands inside two business dates — the day it falls on and the
      // day before, whose morning half it occupies — and the email used to badge
      // both. The owner's rule is simpler and is the one that ships: these
      // cities take one day off a week, so one row a week says so.
      // closedPartOfWindow still exists and the dashboards still use it, where a
      // reader is looking at a single day in isolation and the half-closure
      // explains a number they can see.
      weekOff: isCityClosed(city as City, businessDate, calendar) ? ("full" as const) : null,
      topRisk: top ? { label: top[0], count: top[1].count, team: teamFor(top[1].name) } : null,
      counts:
        hasCounts && st
          ? {
              sheetIn: Number(st.sheet_in ?? 0),
              sheetOut: Number(st.sheet_out ?? 0),
              odooIn: Number(st.odoo_in ?? 0),
              odooOut: Number(st.odoo_out ?? 0),
              dtIn: Number(st.dt_in ?? 0),
              dtOut: Number(st.dt_out ?? 0),
              physIn: Number(st.phys_in ?? 0),
              physOut: Number(st.phys_out ?? 0),
              reported: {
                P: !!st.reported_p, S: !!st.reported_s,
                D: !!st.reported_d, O: !!st.reported_o,
              },
            }
          : undefined,
    });
  }
  cities.sort((a, b) => b.tier1 - a.tier1 || b.tier2 - a.tier2 || a.city.localeCompare(b.city));

  // Actions: aggregate by KIND across cities, not by city. The owner needs to
  // see every kind of risk and its size; the per-city list is one click away.
  const open = rows.filter((v) => v.status !== "closed");
  const groups = new Map<string, ActionItem>();
  for (const v of open) {
    const l = labelOfRow(v);
    if (l.tier === 3) continue;
    // GROUPED BY DISPLAY **AND** ACTION, not by display alone.
    //
    // One display name covers several engine names with DIFFERENT fixes:
    // "Register Gap" is five of them, whose actions run from "Remind the guard
    // post to write every unit in the book" to "Add the missing line to the ops
    // sheet". Keyed on display only, whichever row happened to sort first
    // dictated the instruction for the whole group — so the email routinely told
    // the warehouse to chase the guard about an ops-sheet line.
    //
    // Splitting on the action also makes `team` right per group, and makes
    // `risk` unambiguous for free: action and risk live on the same
    // VarianceLabel, so a group with one action has exactly one risk sentence.
    // Written as an ESCAPE, never a literal byte -- a raw NUL in the source
    // makes git treat this file as binary: no diff, no blame, and an editor
    // can silently mangle it. The watch tally below hit this exact trap.
    const key = `${l.display}\u0000${l.action}`;
    const g = groups.get(key) ?? {
      label: l.display,
      tier: l.tier as 1 | 2,
      count: 0,
      action: l.action,
      risk: l.risk,
      team: teamFor(v.variance_name),
      cities: [],
    };
    g.count++;
    const c = g.cities.find((x) => x.city === v.city);
    if (c) c.count++;
    else g.cities.push({ city: v.city, count: 1 });
    groups.set(key, g);
  }
  const actions = [...groups.values()]
    .map((g) => ({ ...g, cities: g.cities.sort((a, b) => b.count - a.count).slice(0, MAX_CITIES_INLINE + 3) }))
    .sort((a, b) => a.tier - b.tier || b.count - a.count);

  const infoTally = new Map<string, number>();
  for (const v of open) {
    const l = labelOfRow(v);
    if (l.tier !== 3) continue;
    infoTally.set(l.display, (infoTally.get(l.display) ?? 0) + 1);
  }
  const informational = [...infoTally.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  // Best-effort: a slow or failing history query must omit the section, never
  // stop the digest. The cron shares a 60s ceiling with the PDFs and the send.
  const history = await buildWatchList(db, businessDate, open).catch(() => undefined);

  // ONE extra range read for the week's coverage: ~35 rows, a single page.
  // Spent on honesty rather than novelty -- without reported_* per day there is
  // no way to tell a quiet day from a day a book never filed, and the trend
  // would call an outage an improvement. Best-effort, like the history above.
  const trends = history
    ? await (async () => {
        const { data } = await db
          .from("run_city_stats")
          .select("business_date, city, movements, reported_p, reported_s, reported_d, reported_o")
          .gte("business_date", addDays(businessDate, -(WATCH_DAYS - 1)))
          .lte("business_date", businessDate);
        return buildTrends({
          businessDate,
          tier1: history.tier1,
          priorDates: history.priorDates,
          coverage: (data ?? []) as CoverageRow[],
          cities: cities.map((c) => c.city),
          ratio: 1.5,
          minUnits: WATCH_MIN_UNITS,
        });
      })().catch(() => undefined)
    : undefined;

  for (const c of cities) c.trend = trends?.byCity.get(c.city) ?? null;

  // The four-way check. Two reads, both best-effort for the same reason as the
  // history above, and both allowed to come back null — an omitted section beats
  // a section that claims a check it cannot evidence.
  //
  // The date is RESOLVED, not assumed. Zero guard registers have ever been
  // uploaded before their own date's 16:30 run (trends.ts:37-42), so on
  // `businessDate` itself present_p is false almost everywhere and a literal
  // four-way check would score 0/N for every city, every day. This walks back to
  // the newest day whose four sources all reported, and moves forward on its own
  // once register timing improves.
  // REGISTER HANDOVER, per city. Each warehouse owes the register for its own
  // last working day; on a Friday that is Thursday for Delhi and Bangalore and
  // Wednesday for the three cities shut on Thursday.
  const handover: HandoverRow[] = [...byCity.keys()].sort().flatMap((city) => {
    // Null means closed 14+ days straight — a data problem, and asserting the
    // city worked on `businessDate` (the old fallback) stated a falsehood about
    // a shut warehouse. Omit the row; the by-city table still shows the city.
    const lwd = lastWorkingDay(city as City, businessDate, calendar);
    if (lwd === null) return [];
    const statuses = uploadByCityDate.get(`${city}|${lwd}`) ?? [];
    const state: RegisterState =
      statuses.includes("processed") ? "received"
      : statuses.includes("failed") ? "failed"
      : statuses.length > 0 ? "pending"
      : lwd !== businessDate ? "delayed"
      : "missing";
    return [{
      city,
      lastWorkingDay: lwd,
      shutSince: lwd !== businessDate,
      state,
      // When that book is actually handed over. The section renders an absent
      // book as "Due <weekday>" from this — on THIS table a book can never be
      // late, because the newest owed book is always due on or after send day.
      dueOn: registerDueOn(city as City, lwd, calendar),
    }];
  });

  const coverage = await (async () => {
    const date = await latestFullyCoveredDate(db, businessDate);
    if (!date) return undefined;
    return (await readFourWayCoverage(db, date)) ?? undefined;
  })().catch(() => undefined);

  const sum = (f: (c: CityDigestRow) => number) => cities.reduce((n, c) => n + f(c), 0);

  // Identity of every flagged row, for the follow-up's snapshot. Collected here
  // because this is the only place the rows and their tiers are both in hand;
  // never rendered.
  const flaggedKeys = open
    .filter((r) => tierOfRow(r) < 3)
    .map((r) => flaggedKeyOf({
      city: r.city,
      direction: r.direction,
      barcode: r.barcode,
      variance_name: r.variance_name,
    }));

  return {
    flaggedKeys,
    date: businessDate,
    generatedAt: new Date().toISOString(),
    dayTrend: trends?.dayTrend ?? null,
    cleanStreak: trends?.cleanStreak ?? 0,
    totals: {
      movements: sum((c) => c.movements),
      tier1: sum((c) => c.tier1),
      tier2: sum((c) => c.tier2),
      tier3: sum((c) => c.tier3),
      open: sum((c) => c.open),
    },
    cities,
    actions,
    informational,
    coverage,
    handover,
    calendar,
    // Absent, not empty, when the history read failed: "we did not look" and
    // "we looked and found nothing outstanding" are different claims and the
    // section renders them differently.
    ageing: history?.ageing,
    runIncomplete: !runId,
  };
}
