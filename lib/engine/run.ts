// Orchestrator (Section 11 output contract). Per city/date:
//   derive run date → window Odoo → validate/canonicalize → build IN/OUT
//   universes → suppressions → variance ladder + duplicates → direction
//   conflict → count layer → bucket relabel → assemble output.

import { CITIES, type City } from "../sample-data";
import { canonicalize, isPpBox, isSpareOrConsumable, isValidBarcode } from "./barcode";
import { applyBucket } from "./buckets";
import { computeCountLayer } from "./counts";
import { deriveRunDate, parseDate } from "./dates";
import { detectDirectionConflicts } from "./direction-conflict";
import { classify, duplicateHit } from "./ladder";
import { filterOdooWindow } from "./odoo-window";
import { computeSuppressions } from "./suppressions";
import { isSpareJobType } from "./util";
import { buildViews } from "./views";
import { ALL_REPORTED } from "./types";
import type {
  BarcodeView,
  CityRunResult,
  Direction,
  ReportedSources,
  SourceRow,
  VarianceRowOut,
} from "./types";

function baseRow(v: BarcodeView) {
  return {
    barcode: v.canonical,
    city: v.city,
    ticket_id: v.ticketId,
    so_number: v.soNumber,
    customer: v.customer,
    product: v.product,
    job_type: v.jobType,
    date: v.date,
  };
}

export function runReconciliation(
  allRows: SourceRow[],
  city: City,
  reported: ReportedSources = ALL_REPORTED
): CityRunResult {
  const warnings: string[] = [];
  const rows = allRows;

  // Section 3 — derive the run date (throws if unparseable).
  const runDate = deriveRunDate(rows);

  // Section 4 — window the Odoo rows for this city (posting-date based).
  const odooRaw = rows.filter((r) => r.source === "ODOO");
  const odooWindowed = filterOdooWindow(odooRaw, city, runDate, warnings);
  const nonOdoo = rows.filter((r) => r.source !== "ODOO");
  const working = [...nonOdoo, ...odooWindowed];

  // Section 5 — validity split. Spares and PP boxes surface as their own INFO
  // rows (never the per-barcode ladder); invalid placeholders are dropped.
  const spareRows: SourceRow[] = [];
  const ppBoxRows: SourceRow[] = [];
  const valid: SourceRow[] = [];
  for (const r of working) {
    // Placeholder checks first — these labels are long enough to pass the
    // length/alnum test but must never run the normal ladder.
    if (isPpBox(r.barcode)) ppBoxRows.push(r);
    else if (isSpareOrConsumable(r.barcode) || isSpareJobType(r.jobType)) spareRows.push(r);
    else if (isValidBarcode(r.barcode)) valid.push(r);
  }

  const byDir = (dir: Direction) => valid.filter((r) => r.direction === dir);
  const inViews = buildViews(byDir("IN"), city, "IN");
  const outViews = buildViews(byDir("OUT"), city, "OUT");
  for (const v of Array.from(inViews.values())) v.date = runDate;
  for (const v of Array.from(outViews.values())) v.date = runDate;

  // Mark views whose Odoo posting is dated the run day itself — the only ones
  // eligible for "Odoo-Only" (adjacent-day postings are match-targets only;
  // each posting is judged in its own day's run).
  const odooSameDayCanon = new Set<string>();
  for (const r of odooWindowed) {
    const posted = parseDate(r.createdOn) ?? parseDate(r.date);
    if (posted === runDate) odooSameDayCanon.add(canonicalize(r.barcode));
  }
  for (const v of Array.from(inViews.values())) v.odooSameDay = odooSameDayCanon.has(v.canonical);
  for (const v of Array.from(outViews.values())) v.odooSameDay = odooSameDayCanon.has(v.canonical);

  // Section 7 — suppressions (before classification).
  const { suppressed, dtAllPending, silentOcr } = computeSuppressions(
    inViews,
    outViews
  );

  const variances: VarianceRowOut[] = [];

  // Failed-delivery rule (ops practice, from the field): an OUT entry whose
  // every reported status is not_done ("Not Delivered") means the unit left
  // and came back — it must NOT run the normal ladder (a failed delivery is
  // rightly absent from Odoo/DT-done), but its return MUST be logged on the
  // IN side. Missing IN leg → REAL chase item ("write them in Reg inward").
  for (const v of Array.from(outViews.values())) {
    const statuses = [
      ...v.P.statuses,
      ...v.S.statuses,
      ...v.D.statuses,
      ...v.O.statuses,
    ];
    if (statuses.length === 0 || !statuses.every((s) => s === "not_done")) continue;
    suppressed.add(`OUT::${v.canonical}`);
    if (!inViews.has(v.canonical)) {
      variances.push(
        applyBucket({
          barcode: v.canonical,
          city,
          direction: "OUT",
          variance_name: "Failed Delivery — Return Not Logged",
          priority: "High",
          ticket_id: v.ticketId,
          so_number: v.soNumber,
          customer: v.customer,
          product: v.product,
          job_type: v.jobType,
          date: runDate,
        })
      );
    }
  }

  const classifyViews = (views: Map<string, BarcodeView>, direction: Direction) => {
    for (const v of Array.from(views.values())) {
      const k = `${direction}::${v.canonical}`;
      if (silentOcr.has(k)) continue; // never output (Section 7/12)
      if (suppressed.has(k)) continue;

      const hit = classify(v, reported);
      if (hit) {
        variances.push(
          applyBucket({
            ...baseRow(v),
            direction,
            variance_name: hit.variance_name,
            priority: hit.priority,
          })
        );
      }

      // Duplicate scans — unless DT-all-pending suppressed this barcode.
      if (!dtAllPending.has(k)) {
        const dup = duplicateHit(v);
        if (dup) {
          variances.push(
            applyBucket({
              ...baseRow(v),
              direction,
              variance_name: dup.variance_name,
              priority: dup.priority,
            })
          );
        }
      }
    }
  };

  classifyViews(inViews, "IN");
  classifyViews(outViews, "OUT");

  // Spare/Consumable Movement (INFO) — one row per distinct spare barcode.
  const seenSpare = new Set<string>();
  for (const r of spareRows) {
    const kk = `${r.direction}::${r.barcode.toUpperCase()}`;
    if (seenSpare.has(kk)) continue;
    seenSpare.add(kk);
    variances.push(
      applyBucket({
        barcode: r.barcode.toUpperCase(),
        city,
        direction: r.direction,
        variance_name: "Spare/Consumable Movement",
        priority: "Info",
        ticket_id: r.ticketId ?? null,
        so_number: r.soNumber ?? null,
        customer: r.customer ?? null,
        product: r.product ?? null,
        job_type: null,
        date: runDate,
      })
    );
  }

  // PP Box Movement — count-only per direction (packing boxes are free-text
  // counts, not barcodes; the ops email digest needs the number, nothing else).
  for (const dir of ["IN", "OUT"] as Direction[]) {
    const boxRows = ppBoxRows.filter((r) => r.direction === dir);
    if (boxRows.length === 0) continue;
    const sources = Array.from(new Set(boxRows.map((r) => r.source))).join(", ");
    variances.push(
      applyBucket({
        barcode: "PP-BOX",
        city,
        direction: dir,
        variance_name: "PP Box Movement (Count Only)",
        priority: "Info",
        ticket_id: null,
        so_number: null,
        customer: null,
        product: "PP Box",
        job_type: null,
        date: runDate,
        note: `${boxRows.length} PP-box ${dir} entr${boxRows.length === 1 ? "y" : "ies"} logged (${sources}) — count-only, not barcode-tracked.`,
      })
    );
  }

  // Section 8 — direction conflict (already bucketed REAL).
  const conflicts = detectDirectionConflicts(inViews, outViews, suppressed).map(
    (c) => ({ ...c, date: c.date || runDate })
  );
  variances.push(...conflicts);

  // Section 9 — count layer per direction.
  const count_in = computeCountLayer(byDir("IN"));
  const count_out = computeCountLayer(byDir("OUT"));

  // Summary.
  const real_variances = variances.filter((v) => v.bucket === "REAL");
  const info_variances = variances.filter((v) => v.bucket === "INFO");
  // Reconciliation universe size = distinct valid barcodes examined per
  // direction (the leaderboard accuracy denominator).
  const movements = inViews.size + outViews.size;
  const by_variance: Record<string, number> = {};
  for (const v of variances) {
    by_variance[v.variance_name] = (by_variance[v.variance_name] ?? 0) + 1;
  }

  return {
    city,
    date: runDate,
    variances,
    real_variances,
    info_variances,
    count_in,
    count_out,
    summary: {
      total: variances.length,
      real_count: real_variances.length,
      info_count: info_variances.length,
      high_priority: variances.filter((v) => v.priority === "High").length,
      medium_priority: variances.filter((v) => v.priority === "Medium").length,
      movements,
      by_variance,
    },
    warnings,
  };
}

// Demo helper: the admin "Run Reconciliation" button reconciles all five
// cities at once. Rows are grouped by city (SourceRow has no city field, so
// the sample generator tags rows via a parallel map — see sample-raw-sources).
export interface MultiCityRun {
  ranAt: string;
  date: string;
  perCity: CityRunResult[];
  combined: {
    total: number;
    real_count: number;
    info_count: number;
    high_priority: number;
    by_variance: Record<string, number>;
  };
}

export function runAllCities(
  rowsByCity: Record<City, SourceRow[]>,
  now: Date = new Date(),
  reportedByCity?: Partial<Record<City, ReportedSources>>
): MultiCityRun {
  const perCity: CityRunResult[] = [];
  for (const city of CITIES) {
    const rows = rowsByCity[city];
    if (!rows || rows.length === 0) continue;
    perCity.push(runReconciliation(rows, city, reportedByCity?.[city] ?? ALL_REPORTED));
  }

  const by_variance: Record<string, number> = {};
  let total = 0;
  let real_count = 0;
  let info_count = 0;
  let high_priority = 0;
  for (const c of perCity) {
    total += c.summary.total;
    real_count += c.summary.real_count;
    info_count += c.summary.info_count;
    high_priority += c.summary.high_priority;
    for (const [k, n] of Object.entries(c.summary.by_variance)) {
      by_variance[k] = (by_variance[k] ?? 0) + n;
    }
  }

  return {
    ranAt: now.toISOString(),
    date: perCity[0]?.date ?? "",
    perCity,
    combined: { total, real_count, info_count, high_priority, by_variance },
  };
}
