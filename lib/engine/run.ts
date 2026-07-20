// Orchestrator (Section 11 output contract). Per city/date:
//   derive run date → window Odoo → validate/canonicalize → build IN/OUT
//   universes → suppressions → variance ladder + duplicates → direction
//   conflict → count layer → bucket relabel → assemble output.

import { CITIES, type City } from "../sample-data";
import { canonicalize, isPpBox, isSpareOrConsumable, isValidBarcode } from "./barcode";
import { applyBucket } from "./buckets";
import { computeCountLayer } from "./counts";
import { addDays, deriveRunDate, parseDate } from "./dates";
import { detectDirectionConflicts } from "./direction-conflict";
import { classify, duplicateHit } from "./ladder";
import { filterOdooWindow } from "./odoo-window";
import { computeSuppressions } from "./suppressions";
import { isSpareJobType, normalizeJobType } from "./util";
import { bestGuardMatch } from "./fuzzy";
import { buildViews, mergeGuardPresence } from "./views";
import { VARIANCE } from "./variance-names";
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

// Fold guard-only OCR-mangled "orphan" barcodes into the matching typed-source
// item (same direction). An orphan is present in PHYSICAL only; a target is a
// view missing PHYSICAL but present in ≥1 typed source. bestGuardMatch links
// them on ticket / SO-PO / near-identical barcode and skips ambiguous ties. On a
// match the orphan's PHYSICAL presence is merged into the target and the orphan
// view is deleted, so the corrected view reconciles through the unchanged ladder.
function mergeOcrOrphans(views: Map<string, BarcodeView>, warnings: string[]) {
  const all = Array.from(views.values());
  const orphans = all.filter(
    (v) => v.P.present && !v.S.present && !v.D.present && !v.O.present
  );
  const targets = all.filter(
    (v) => !v.P.present && (v.S.present || v.D.present || v.O.present)
  );
  if (orphans.length === 0 || targets.length === 0) return;
  for (const orphan of orphans) {
    const match = bestGuardMatch(orphan, targets);
    if (!match) continue;
    mergeGuardPresence(match, orphan);
    views.delete(orphan.canonical);
    warnings.push(
      `OCR merge (${orphan.direction}): guard ${orphan.canonical} → ${match.canonical} (ticket/SO/barcode match)`
    );
  }
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

  // Section 5 — validity split. Spares and PP boxes surface as counts (never the
  // per-barcode ladder); invalid placeholders are dropped.
  //
  // Spare/consumable is a BARCODE-level property: spares live in the register,
  // ops sheet and DT but NEVER in Odoo, so they must never reach the ladder —
  // otherwise a spare would falsely flag "not in Odoo". If ANY source row for a
  // barcode marks it spare (barcode/product text OR ops-type), the whole barcode
  // is a spare and every one of its rows goes to counts (this closes the gap
  // where, say, the DT row lacks the spare tag the ops sheet carries).
  const spareCanon = new Set<string>();
  for (const r of working) {
    if (!isPpBox(r.barcode) && (isSpareOrConsumable(r.barcode) || isSpareJobType(r.jobType)))
      spareCanon.add(canonicalize(r.barcode));
  }
  const spareRows: SourceRow[] = [];
  const ppBoxRows: SourceRow[] = [];
  const valid: SourceRow[] = [];
  for (const r of working) {
    // Placeholder checks first — these labels are long enough to pass the
    // length/alnum test but must never run the normal ladder.
    if (isPpBox(r.barcode)) ppBoxRows.push(r);
    else if (spareCanon.has(canonicalize(r.barcode))) spareRows.push(r);
    else if (isValidBarcode(r.barcode)) valid.push(r);
  }

  const byDir = (dir: Direction) => valid.filter((r) => r.direction === dir);
  const inViews = buildViews(byDir("IN"), city, "IN");
  const outViews = buildViews(byDir("OUT"), city, "OUT");
  for (const v of Array.from(inViews.values())) v.date = runDate;
  for (const v of Array.from(outViews.values())) v.date = runDate;

  // OCR-tolerant merge (before Odoo-same-day stamping, suppressions and the
  // ladder) — fold a guard-only OCR-mangled barcode into the matching
  // typed-source item so one OCR slip doesn't raise two false REAL variances (a
  // P-only "Gate-Only Dispatch" AND the real item's "Gate Log Missing"). Matches
  // on ticket / SO-PO / near-identical barcode; same-direction only (separate
  // maps); ambiguous ties are skipped (see fuzzy.ts).
  mergeOcrOrphans(inViews, warnings);
  mergeOcrOrphans(outViews, warnings);

  // Mark views whose Odoo posting is dated the run day itself — the only ones
  // eligible for "Odoo-Only" (adjacent-day postings are match-targets only;
  // each posting is judged in its own day's run).
  const odooSameDayCanon = new Set<string>();
  // 1-day late-entry buffer: postings dated runDate+1 (already in odooWindowed,
  // which spans ±1 day). A floor-confirmed movement whose only Odoo evidence is
  // a next-day posting is an "entry made late" INFO, not a REAL missing posting.
  const nextDay = addDays(runDate, 1);
  const odooNextDayCanon = new Set<string>();
  for (const r of odooWindowed) {
    const posted = parseDate(r.createdOn) ?? parseDate(r.date);
    if (posted === runDate) odooSameDayCanon.add(canonicalize(r.barcode));
    else if (posted === nextDay) odooNextDayCanon.add(canonicalize(r.barcode));
  }
  for (const v of Array.from(inViews.values())) {
    v.odooSameDay = odooSameDayCanon.has(v.canonical);
    v.odooNextDay = odooNextDayCanon.has(v.canonical);
  }
  for (const v of Array.from(outViews.values())) {
    v.odooSameDay = odooSameDayCanon.has(v.canonical);
    v.odooNextDay = odooNextDayCanon.has(v.canonical);
  }

  // Section 7 — suppressions (before classification).
  const { suppressed, dtAllPending, silentOcr } = computeSuppressions(
    inViews,
    outViews,
    reported
  );

  // DT enrichment (display only) — an Odoo-only variance carries Odoo's picking
  // reference / procurement status in ticket_id/job_type, not the real ticket +
  // ops type. Replace them with the Delivery Tracker's ticket + ops for the same
  // barcode (any direction); blank (→ "—" / empty) when DT has no row for it.
  // Runs AFTER suppressions (so it never changes which variances fire) and the
  // ladder ignores these two fields, so only the display columns change.
  const dtByBarcode = new Map<string, { ticketId: string | null; jobType: string | null }>();
  for (const r of valid) {
    if (r.source !== "DT") continue;
    const key = canonicalize(r.barcode);
    const cur = dtByBarcode.get(key);
    dtByBarcode.set(key, {
      ticketId: cur?.ticketId ?? (r.ticketId?.trim() || null),
      jobType: cur?.jobType ?? normalizeJobType(r.jobType),
    });
  }
  const enrichOdooOnly = (views: Map<string, BarcodeView>) => {
    for (const v of Array.from(views.values())) {
      if (!(v.O.present && !v.P.present && !v.S.present && !v.D.present)) continue; // Odoo-only
      const dt = dtByBarcode.get(v.canonical);
      v.ticketId = dt?.ticketId ?? null;
      v.jobType = dt?.jobType ?? null;
    }
  };
  enrichOdooOnly(inViews);
  enrichOdooOnly(outViews);

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
          variance_name: VARIANCE.FAILED_DELIVERY,
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

  // PP boxes and spares/consumables are count-only movements (packing boxes are
  // free-text counts, spares aren't barcode-reconciled) — they are NOT variances.
  // Surface them as per-city counts (summary) instead of flooding the INFO list.
  const pp_box_count = ppBoxRows.length;
  const seenSpare = new Set<string>();
  for (const r of spareRows) seenSpare.add(`${r.direction}::${r.barcode.toUpperCase()}`);
  const consumable_count = seenSpare.size;

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
      pp_box_count,
      consumable_count,
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
