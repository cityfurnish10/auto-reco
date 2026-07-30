// GET /api/stock/movements?from=&to=&city=&groupBy=day|city|day-city
//
// How much stock each warehouse handled, over any range.
//
// AUTHORITATIVE SOURCE: count(*) FROM movement_events WHERE is_movement.
//
// movement_events and run_city_stats.movements use the IDENTICAL isMovement
// predicate (lib/engine/run.ts computes it once and feeds both), so for a single
// run they are the same number. They diverge across runs, and the divergence is
// why the ledger wins: saveCityStats upserts on (business_date, city), so
// `movements` is whatever the LAST run saw, while upsertMovementEvents upserts on
// the natural key, so a unit an earlier run confirmed stays in the ledger. On
// 2026-07-26 the rollup collapses from 101 to 26 and the ledger does not. A
// movement any run confirmed did happen.
//
// The rollup is the fallback for dates before the ledger existed. It is a scalar:
// no IN/OUT split, no outcome split, no barcode. Those fields come back null, not
// zero — a zero would read as "nothing moved".

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { readCityStats, readMovements } from "@/lib/stock/db";
import { daysBetween } from "@/lib/engine/dates";
import { isCityOff } from "@/lib/engine/schedule";
import type { City } from "@/lib/sample-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Above this span the per-unit read stops being worth its cost; use the rollup. */
const LEDGER_MAX_DAYS = 31;

export interface MovementBucket {
  key: string;
  date: string | null;
  city: string | null;
  /** A movement_events row exists. False ⇒ every count below is null. */
  ledgered: boolean;
  restDay: boolean;
  in: number | null;
  out: number | null;
  /** in + out — "movements handled". Reconciles against run_city_stats.movements. */
  total: number | null;
  /** COUNT(DISTINCT barcode). A set size: NOT summable across buckets. */
  distinctUnits: number | null;
  bothDirections: number | null;
  clean: number | null;
  problems: number | null;
  backfilled: number | null;
  /** All four books read on this day, from run_city_stats. null before 0012. */
  booksRead: number | null;
}

export async function GET(req: NextRequest) {
  const me = await getCurrentAppUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const q = req.nextUrl.searchParams;
  const from = (q.get("from") ?? "").trim();
  const to = (q.get("to") ?? "").trim();
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return NextResponse.json({ error: "from and to must be YYYY-MM-DD" }, { status: 400 });
  }
  if (from > to) {
    return NextResponse.json({ error: "from is after to" }, { status: 400 });
  }
  const groupBy = (q.get("groupBy") ?? "day-city") as "day" | "city" | "day-city";
  const cityFilter = q.getAll("city").filter(Boolean);

  const db = createAdminClient();
  const span = daysBetween(from, to) + 1;

  let ledger, stats;
  try {
    [ledger, stats] = await Promise.all([
      span <= LEDGER_MAX_DAYS ? readMovements(db, from, to) : Promise.resolve(null),
      readCityStats(db, from, to),
    ]);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }

  const inScope = (c: string) => cityFilter.length === 0 || cityFilter.includes(c);
  const rows = (ledger ?? []).filter((r) => inScope(r.city));
  const statRows = stats.filter((r) => inScope(r.city));

  // Which dates the ledger actually covers. Computed from ROW EXISTENCE, never
  // from count > 0: a genuine zero-movement day is ledgered with in=0, out=0, and
  // must not be drawn as a gap.
  const ledgeredDates = new Set(rows.map((r) => r.business_date));
  const firstLedgeredDate = [...ledgeredDates].sort()[0] ?? null;
  const statDates = new Set(statRows.map((r) => r.business_date));
  const allDates = [...new Set([...ledgeredDates, ...statDates])].sort();

  // The per-source split only exists from migration 0012.
  const firstPerSource =
    statRows
      .filter((r) => r.reported_p !== null)
      .map((r) => r.business_date)
      .sort()[0] ?? null;

  type Acc = {
    in: number; out: number; clean: number; problems: number; backfilled: number;
    barcodes: Set<string>; inBarcodes: Set<string>; outBarcodes: Set<string>;
  };
  const mk = (): Acc => ({
    in: 0, out: 0, clean: 0, problems: 0, backfilled: 0,
    barcodes: new Set(), inBarcodes: new Set(), outBarcodes: new Set(),
  });

  const keyOf = (date: string, city: string) =>
    groupBy === "day" ? date : groupBy === "city" ? city : `${date}|${city}`;

  const acc = new Map<string, Acc>();
  for (const r of rows) {
    if (!r.is_movement) continue; // non-movements are match targets, not handling
    const k = keyOf(r.business_date, r.city);
    const a = acc.get(k) ?? mk();
    if (r.direction === "IN") { a.in++; a.inBarcodes.add(r.barcode); }
    else { a.out++; a.outBarcodes.add(r.barcode); }
    a.barcodes.add(r.barcode);
    if (r.outcome === "CLEAN") a.clean++;
    if (r.outcome === "REAL" || r.outcome === "INFO") a.problems++;
    if (r.backfilled) a.backfilled++;
    acc.set(k, a);
  }

  // Rollup totals per key, for dates the ledger cannot cover.
  const rollup = new Map<string, number>();
  const books = new Map<string, number>();
  for (const s of statRows) {
    const k = keyOf(s.business_date, s.city);
    rollup.set(k, (rollup.get(k) ?? 0) + (s.movements ?? 0));
    if (s.reported_p !== null) {
      const n =
        (s.reported_p ? 1 : 0) + (s.reported_s ? 1 : 0) +
        (s.reported_d ? 1 : 0) + (s.reported_o ? 1 : 0);
      books.set(k, Math.min(books.get(k) ?? 4, n));
    }
  }

  const cities = [...new Set([...rows.map((r) => r.city), ...statRows.map((r) => r.city)])].sort();
  const keys =
    groupBy === "day" ? allDates
    : groupBy === "city" ? cities
    : allDates.flatMap((d) => cities.map((c) => `${d}|${c}`));

  const buckets: MovementBucket[] = keys.map((k) => {
    const [d, c] =
      groupBy === "day" ? [k, null] : groupBy === "city" ? [null, k] : (k.split("|") as [string, string]);
    const a = acc.get(k);
    const ledgered = groupBy === "city" ? ledgeredDates.size > 0 : !!d && ledgeredDates.has(d);
    const restDay = !!d && !!c && isCityOff(c as City, d);
    const rollupTotal = rollup.get(k) ?? null;

    if (!a) {
      // No ledger rows. Either the date predates the ledger — show the rollup total
      // with the split unavailable — or nothing moved on a ledgered day.
      const total = ledgered ? 0 : rollupTotal;
      return {
        key: k, date: d, city: c, ledgered, restDay,
        in: ledgered ? 0 : null,
        out: ledgered ? 0 : null,
        total,
        distinctUnits: ledgered ? 0 : null,
        bothDirections: ledgered ? 0 : null,
        clean: ledgered ? 0 : null,
        problems: ledgered ? 0 : null,
        backfilled: ledgered ? 0 : null,
        booksRead: books.get(k) ?? null,
      };
    }
    let both = 0;
    for (const bc of a.inBarcodes) if (a.outBarcodes.has(bc)) both++;
    return {
      key: k, date: d, city: c, ledgered: true, restDay,
      in: a.in, out: a.out, total: a.in + a.out,
      distinctUnits: a.barcodes.size,
      bothDirections: both,
      clean: a.clean, problems: a.problems, backfilled: a.backfilled,
      booksRead: books.get(k) ?? null,
    };
  });

  // Totals recomputed over the WHOLE range, not summed from buckets: distinctUnits
  // is a set size and a unit recurring on two days would be counted twice.
  const allBarcodes = new Set<string>();
  let tIn = 0, tOut = 0, tBack = 0;
  for (const r of rows) {
    if (!r.is_movement) continue;
    allBarcodes.add(r.barcode);
    if (r.direction === "IN") tIn++; else tOut++;
    if (r.backfilled) tBack++;
  }
  const ledgerMovements = ledger === null ? null : tIn + tOut;
  const rollupMovements = statRows.reduce((n, s) => n + (s.movements ?? 0), 0);

  return NextResponse.json({
    from, to, groupBy,
    source: ledger === null ? "rollup" : "ledger",
    scope: { cities },
    coverage: {
      firstLedgeredDate,
      firstPerSourceDate: firstPerSource,
      firstRollupDate: [...statDates].sort()[0] ?? null,
      unledgeredDates: allDates.filter((d) => !ledgeredDates.has(d)),
      backfilledShare: ledgerMovements ? tBack / Math.max(1, tIn + tOut) : null,
      ledgerCapDays: LEDGER_MAX_DAYS,
    },
    buckets,
    totals: {
      in: ledger === null ? null : tIn,
      out: ledger === null ? null : tOut,
      total: ledgerMovements ?? rollupMovements,
      distinctUnits: ledger === null ? null : allBarcodes.size,
      ledgerMovements,
      rollupMovements,
      // Expected >= 0: the ledger is a high-water union across every run of a
      // date, the rollup is the last run's snapshot. A NEGATIVE drift means
      // something wrote the rollup without writing the ledger, and is an alarm.
      drift: ledgerMovements === null ? null : ledgerMovements - rollupMovements,
    },
  });
}
