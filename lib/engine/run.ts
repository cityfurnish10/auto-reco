// Orchestrator (Section 11 output contract). Per city/date:
//   derive run date → window Odoo → validate/canonicalize → build IN/OUT
//   universes → suppressions → variance ladder + duplicates → direction
//   conflict → count layer → bucket relabel → assemble output.

import { CITIES, type City } from "../sample-data";
import { isSpareOrConsumable, isValidBarcode } from "./barcode";
import { applyBucket } from "./buckets";
import { computeCountLayer } from "./counts";
import { deriveRunDate } from "./dates";
import { detectDirectionConflicts } from "./direction-conflict";
import { classify, duplicateHit } from "./ladder";
import { filterOdooWindow } from "./odoo-window";
import { computeSuppressions } from "./suppressions";
import { buildViews } from "./views";
import type {
  BarcodeView,
  CityRunResult,
  Direction,
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
  city: City
): CityRunResult {
  const warnings: string[] = [];
  const rows = allRows;

  // Section 3 — derive the run date (throws if unparseable).
  const runDate = deriveRunDate(rows);

  // Section 4 — window the Odoo rows for this city.
  const odooRaw = rows.filter((r) => r.source === "ODOO");
  const odooWindowed = filterOdooWindow(odooRaw, city, runDate, warnings);
  const nonOdoo = rows.filter((r) => r.source !== "ODOO");
  const working = [...nonOdoo, ...odooWindowed];

  // Section 5 — validity split. Spares surface as their own INFO variance;
  // invalid placeholders are dropped from the universe entirely.
  const spareRows: SourceRow[] = [];
  const valid: SourceRow[] = [];
  for (const r of working) {
    // Spare/consumable check first — these are placeholders per Section 5 and
    // must surface as their own INFO variance, not run the normal ladder,
    // even though the label is long enough to pass the length/alnum test.
    if (isSpareOrConsumable(r.barcode)) spareRows.push(r);
    else if (isValidBarcode(r.barcode)) valid.push(r);
  }

  const byDir = (dir: Direction) => valid.filter((r) => r.direction === dir);
  const inViews = buildViews(byDir("IN"), city, "IN");
  const outViews = buildViews(byDir("OUT"), city, "OUT");
  for (const v of Array.from(inViews.values())) v.date = runDate;
  for (const v of Array.from(outViews.values())) v.date = runDate;

  // Section 7 — suppressions (before classification).
  const { suppressed, dtAllPending, silentOcr } = computeSuppressions(
    inViews,
    outViews
  );

  const variances: VarianceRowOut[] = [];

  const classifyViews = (views: Map<string, BarcodeView>, direction: Direction) => {
    for (const v of Array.from(views.values())) {
      const k = `${direction}::${v.canonical}`;
      if (silentOcr.has(k)) continue; // never output (Section 7/12)
      if (suppressed.has(k)) continue;

      const hit = classify(v);
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
  now: Date = new Date()
): MultiCityRun {
  const perCity: CityRunResult[] = [];
  for (const city of CITIES) {
    const rows = rowsByCity[city];
    if (!rows || rows.length === 0) continue;
    perCity.push(runReconciliation(rows, city));
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
