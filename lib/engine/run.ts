// Orchestrator (Section 11 output contract). Per city/date:
//   derive run date → window Odoo → validate/canonicalize → build IN/OUT
//   universes → suppressions → variance ladder + duplicates → direction
//   conflict → count layer → bucket relabel → assemble output.

import { CITIES, type City } from "../sample-data";
import {
  canonicalize,
  isPpBox,
  isSpareOrConsumable,
  isValidBarcode,
  looksUnresolvedItem,
} from "./barcode";
import { applyBucket } from "./buckets";
import { computeCountLayer } from "./counts";
import { addDays, deriveRunDate, parseDate } from "./dates";
import { detectDirectionConflicts } from "./direction-conflict";
import { classify, duplicateHit } from "./ladder";
import { filterOdooWindow } from "./odoo-window";
import { isCityOff } from "./schedule";
import { computeSuppressions } from "./suppressions";
import { isSpareJobType, normalizeJobType, normalizeStatus } from "./util";
import { grammarSuspect, isSummaryLine } from "./ocr-noise";
import { bestGuardMatch } from "./fuzzy";
import {
  buildViews,
  displayBarcode,
  mergeGuardPresence,
  presenceOf,
} from "./views";
import { VARIANCE } from "./variance-names";
import { ALL_REPORTED } from "./types";
import type {
  BarcodeView,
  CityRunResult,
  Direction,
  MovementEvent,
  Priority,
  ReportedSources,
  SourceRow,
  VarianceRowOut,
} from "./types";

function baseRow(v: BarcodeView) {
  return {
    barcode: v.canonical,
    barcode_display: displayBarcode(v),
    city: v.city,
    ticket_id: v.ticketId,
    so_number: v.soNumber,
    customer: v.customer,
    product: v.product,
    job_type: v.jobType,
    date: v.date,
    // Read here, at emit time — presenceOf's header explains why a snapshot
    // taken during buildViews would be wrong for OCR-merged units.
    present: presenceOf(v),
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
  reported: ReportedSources = ALL_REPORTED,
  // Canonical barcodes any FLOOR source (guard/sheet/DT) logged on NEARBY days
  // (runDate−3 … runDate+1, excluding the run day) — supplied by the pipeline
  // from source_rows history, empty in demo/tests. Drives the date-misalignment
  // demotions: a single-source-only row whose unit is floor-documented on an
  // adjacent day is an echo (register page spanning days / late write-up), and
  // an Odoo record created today for a floor-documented earlier movement is a
  // backlog entry — neither is a loss.
  recentFloor: ReadonlySet<string> = new Set(),
  // The date the caller INTENDS to reconcile (the pipeline always knows it).
  // Used when Section-3 derivation has nothing to work from — a city whose
  // register wasn't uploaded AND whose DT was quiet still reconciles its
  // Sheet+Odoo rows against this date instead of throwing.
  fallbackDate?: string,
  // `${direction}::${canonical}` for every unit ODOO posted in the days AFTER
  // the run date (+1 … +3) — supplied by the pipeline from stored history,
  // empty in demo/tests. Drives the late-posting demotion: a "not in Odoo"
  // accusation is false when Odoo demonstrably holds the unit and simply posted
  // it a few days after the goods moved. See loadRecentOdooPostings.
  recentOdoo: ReadonlySet<string> = new Set()
): CityRunResult {
  const warnings: string[] = [];
  const rows = allRows;

  // Section 3 — derive the run date. Derivation reads physical/DT dates; when
  // neither source has a parseable date the intended date (if supplied) takes
  // over, so a no-register no-DT day still reconciles the remaining sources.
  let runDate: string;
  try {
    runDate = deriveRunDate(rows);
  } catch (err) {
    if (!fallbackDate) throw err;
    runDate = fallbackDate;
    warnings.push(
      `Run-date derivation had no physical/DT dates — using the requested date ${fallbackDate}.`
    );
  }

  // Section 4 — window the Odoo rows for this city (posting-date based).
  const odooRaw = rows.filter((r) => r.source === "ODOO");
  const odooWindowed = filterOdooWindow(odooRaw, city, runDate, warnings);
  const nonOdoo = rows.filter((r) => r.source !== "ODOO");

  // DONE TASKS ONLY (owner's rule, 2026-08-01). The purpose of reconciliation
  // is checking that every COMPLETED movement is marked correctly everywhere.
  // A row whose own book says the task did not happen — the ops sheet's
  // "Not Delivered", a cancellation — is not a movement and must not raise a
  // variance or stand in for presence. Measured: 188 of the last three days'
  // sheet rows carried "not delivered", and each one could seed a false
  // "Ops Sheet Only" REAL or a Ghost Dispatch. "pending" rows stay: a task
  // mid-flight is still evidence the system knows the unit, and the existing
  // dampening handles them.
  const preFilter = [...nonOdoo, ...odooWindowed];

  // DONE WINS, ACROSS SOURCES (owner's rule, 2026-08-02). A unit is done or it
  // is not — the books cannot disagree about that and both be right. If ANY
  // source says the movement completed, the unit is done everywhere and the
  // whole unit reconciles normally. Only when NO source claims completion does
  // the not-done verdict stand, and then the unit leaves reconciliation
  // entirely (done-tasks-only).
  //
  // Keyed per unit — direction + canonical barcode — because one leg failing
  // says nothing about the other: a delivery that came back is a not-done OUT
  // and a genuine IN.
  const unitKey = (r: SourceRow) => `${r.direction}::${canonicalize(r.barcode)}`;
  const anyDone = new Set<string>();
  for (const r of preFilter) {
    if (normalizeStatus(r.status) === "done") anyDone.add(unitKey(r));
  }
  const notDoneRows = preFilter.filter(
    (r) => normalizeStatus(r.status) === "not_done" && !anyDone.has(unitKey(r))
  );
  const notDoneUnits = new Set(notDoneRows.map(unitKey));
  const working = preFilter.filter((r) => !notDoneUnits.has(unitKey(r)));
  if (notDoneRows.length > 0) {
    warnings.push(
      `${notDoneRows.length} not-done row${notDoneRows.length === 1 ? "" : "s"} excluded (done-tasks-only rule)`
    );
  }

  // Section 5 — validity split. Spares and PP boxes surface as counts (never the
  // per-barcode ladder); invalid placeholders are dropped.
  //
  // Spare/consumable is a BARCODE-level property: spares live in the register,
  // ops sheet and DT but NEVER in Odoo, so they must never reach the ladder —
  // otherwise a spare would falsely flag "not in Odoo". If ANY source row for a
  // barcode marks it spare (barcode/product text OR ops-type), the whole barcode
  // is a spare and every one of its rows goes to counts (this closes the gap
  // where, say, the DT row lacks the spare tag the ops sheet carries).
  //
  // A barcode any SERIALIZED system knows (DT / Odoo / the guard register) is a
  // real tracked unit and can never be reclassified by ops-sheet text. That
  // guard is what makes the weaker text signals below safe to use: measured on
  // live data, 217 of 219 rows whose sheet item name read "Not Found" appeared
  // in no other system and were genuinely spares — but the other 2 were real
  // Odoo lot serials ("# Luna Wardrobe") whose sheet line simply had a blank
  // product column. Without this check those receipts would vanish from
  // reconciliation into the count layer.
  const knownElsewhere = new Set<string>();
  for (const r of working) {
    if (r.source !== "SHEET") knownElsewhere.add(canonicalize(r.barcode));
  }
  // Ops-sheet hints: the item name or the remarks column saying this is a spare,
  // a consumable, or an item the product lookup could not resolve.
  const sheetHintsSpare = (r: SourceRow): boolean =>
    !knownElsewhere.has(canonicalize(r.barcode)) &&
    (isSpareOrConsumable(r.product ?? "") ||
      isSpareOrConsumable(r.remarks ?? "") ||
      looksUnresolvedItem(r.product));

  // PP BOXES ARE WRITTEN IN BOTH FREE-TEXT BOOKS, NOT JUST THE SHEET.
  //
  // The guard register is handwritten and read by OCR — the same free-text
  // medium as the ops sheet, and the guards use it the same way: a packing-box
  // line whose "barcode" column holds a COUNT ("1", "8", "37") and whose item
  // column holds the description ("PP BOX", "pp box TV"). Treating the register
  // as a corroborating system for this hint meant a box the guard described in
  // the item column could never be recognised as one, because the register's own
  // row was the thing vouching for it.
  //
  // Measured over the retained window on 2026-08-10: 45 such rows, 15 distinct
  // units, every one of them from the register, and NOT ONE of them known to DT
  // or Odoo on any day — so none is a serialized rental unit. One was raising a
  // REAL "Gate Register Only" chase item against a television packing box.
  //
  // CORROBORATION NOW MEANS A TYPED SERIALIZED SYSTEM. That is the guard's real
  // intent (barcode.ts:28-38): a unit DT or Odoo knows is tracked stock and no
  // free-text column may reclassify it. A second handwritten book saying the
  // same thing is not independent evidence. `knownElsewhere` above keeps its
  // original wider meaning for the SPARE hint, whose text signals are weaker —
  // "Not Found" is a blank product column as often as it is a consumable, and
  // that is exactly the case the wider guard was measured to protect.
  //
  // The phrase itself carries the safety: /\bpp\s*box/i appears in no furniture
  // catalogue name, so the hint is applied only to the two books that write
  // free text and never to DT's or Odoo's product column.
  const knownToTypedSystem = new Set<string>();
  for (const r of working) {
    if (r.source === "DT" || r.source === "ODOO") knownToTypedSystem.add(canonicalize(r.barcode));
  }
  const handwritten = (r: SourceRow) => r.source === "SHEET" || r.source === "PHYSICAL";
  const sheetHintsPpBox = (r: SourceRow): boolean =>
    handwritten(r) &&
    !knownToTypedSystem.has(canonicalize(r.barcode)) &&
    (isPpBox(r.product ?? "") || isPpBox(r.remarks ?? ""));

  const ppBoxCanon = new Set<string>();
  const spareCanon = new Set<string>();
  for (const r of working) {
    if (isPpBox(r.barcode) || sheetHintsPpBox(r)) ppBoxCanon.add(canonicalize(r.barcode));
  }
  for (const r of working) {
    if (ppBoxCanon.has(canonicalize(r.barcode))) continue; // PP box wins
    if (isSpareOrConsumable(r.barcode) || isSpareJobType(r.jobType) || sheetHintsSpare(r))
      spareCanon.add(canonicalize(r.barcode));
  }
  const spareRows: SourceRow[] = [];
  const ppBoxRows: SourceRow[] = [];
  const valid: SourceRow[] = [];
  for (const r of working) {
    // The register's own furniture first: a footer written across the barcode
    // boxes parses as a movement ("COUNT 014 ITEMS" → C0UNT0141TEM5, "Total 9")
    // and can only ever raise a false Gate-Only HIGH. Guard rows only — a typed
    // source cannot produce these, and a sheet product legitimately says
    // "count" things. Not routed to the spare/PP counts either: a total line's
    // number is the guard adding up, not a unit that moved.
    if (r.source === "PHYSICAL" && isSummaryLine(r.barcode, r.product)) {
      warnings.push(
        `guard summary line skipped: ${r.barcode}${r.product ? ` / ${r.product}` : ""}`
      );
      continue;
    }
    // Placeholder checks next — these labels are long enough to pass the
    // length/alnum test but must never run the normal ladder.
    if (ppBoxCanon.has(canonicalize(r.barcode))) ppBoxRows.push(r);
    else if (spareCanon.has(canonicalize(r.barcode))) spareRows.push(r);
    else if (isValidBarcode(r.barcode)) valid.push(r);
  }

  const byDir = (dir: Direction) => valid.filter((r) => r.direction === dir);
  // The per-barcode ladder must see only serialized, valid units. The movement
  // summary is different: it is the count each book recorded, so count-only
  // PP/spare/consumable rows still belong in the email/dashboard totals.
  const countableRows = [...valid, ...spareRows, ...ppBoxRows];
  const countByDir = (dir: Direction) => countableRows.filter((r) => r.direction === dir);
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

  // Guard OCR fragments — a still-orphan P-only view whose canonical has no
  // letters left is a partial register read ("3040373", "060006"): typed
  // sources never produce pure-digit barcodes (measured on live data: 0/2811
  // DT, 0/12538 Odoo, 0/1170 Sheet vs 124 in PHYSICAL). The merge pass above
  // already had its chance to rescue it via ticket/SO; unmerged it can only
  // ever raise a false "Gate Register Only" — drop it (with an audit warning).
  const dropOcrFragments = (views: Map<string, BarcodeView>) => {
    let parked = 0;
    for (const v of Array.from(views.values())) {
      const pOnly = v.P.present && !v.S.present && !v.D.present && !v.O.present;
      // Grammar-implausible P-only reads, the wider sibling of the digits-only
      // drop below: measured against 13,674 system-typed barcodes (99.6%
      // alphanumeric, 93% exactly 14 chars), a gate-only read under 10 chars,
      // over 17, near digit-free or carrying stray punctuation is an OCR
      // artifact, not a unit ("N42150", "08166F", "F4M410825040067112"). The
      // merge pass above already had its chance to rescue it; unmerged it can
      // only raise a false Gate-Only HIGH. Deleted, not suppressed, on the same
      // deliberate grounds as the fragments: a garbage read is not a movement,
      // so it must not sit in the accuracy denominator either.
      if (pOnly && /[A-Z]/.test(v.canonical) && grammarSuspect(v.canonical)) {
        views.delete(v.canonical);
        parked++;
        warnings.push(
          `unreadable gate line parked (${v.direction}): guard ${v.canonical} (implausible barcode, no match)`
        );
        continue;
      }
      if (pOnly && !/[A-Z]/.test(v.canonical)) {
        views.delete(v.canonical);
        warnings.push(
          `OCR fragment dropped (${v.direction}): guard ${v.canonical} (digits-only partial read, no match)`
        );
      }
    }
  };
  dropOcrFragments(inViews);
  dropOcrFragments(outViews);

  // Mark views whose Odoo posting is dated the run day itself — the only ones
  // eligible for "Odoo-Only" (adjacent-day postings are match-targets only;
  // each posting is judged in its own day's run).
  //
  // DIRECTION-KEYED, on the same argument odooCustomerDirCanon spells out below
  // and for want of which these two were quietly wrong. A serial received from
  // the vendor (IN) and delivered to a customer (OUT) within a day of each other
  // is two movements, and a canonical-only key lets either leg answer for the
  // other — so an inward posting could mark the OUTWARD view "posted in Odoo
  // today" when Odoo holds no outward posting at all.
  //
  // Traced on a live row: PUNE 2026-08-06, AP815719051098, direction OUT, REAL
  // "Moved on Floor + DT — Not Posted in Odoo". A full paged PUN pull (all
  // states, all movement types, untruncated) shows PUN/IN/08454 posted In on
  // 2026-08-06 and the only Out posting on 2026-08-07 — zero done OUT postings
  // on the accused day — yet the stored ledger row reads odoo_same_day = true.
  // (Its odoo_next_day = true is CORRECT and unaffected: there really is a done
  // Out posting on the 7th. This row evidences the same-day leak only.)
  //
  // Scale, measured over 2026-08-01…09: 222 of 5,501 ledger rows carry
  // odoo_same_day with no same-direction done posting that day, and 111 of them
  // carry "Odoo Posting Only — No Gate / Ops / DT Record" — High, REAL, gated on
  // odooSameDay at ladder.ts rung 9 — plus 8 ODOO_ONLY_TODAY. Roughly 119 false
  // chase items in nine days. A further 368 carry a leaked odoo_next_day, but
  // none of those are ODOO_POSTED_NEXT_DAY, so no demotion is lost.
  //
  // This matters most to whatever READS the flags as evidence: the absence gate
  // in resolveStaleOpenVariances retires a row when the book it accused now
  // holds the unit, and a leaked flag would have it retire a true accusation.
  //
  // IT MOVES A PUBLISHED NUMBER, so expect the discontinuity rather than
  // discover it. isMovement is `P || S || D || odooSameDay` (below), the
  // accuracy denominator, and tightening the flag can only shrink it: measured
  // 0.20%-1.42% fewer movements per day over 2026-08-05…09, plus 9 rung-9
  // Odoo-only rows that stop being emitted on 2026-08-09. real_count barely
  // moves, so a re-run of an already-published day nudges its accuracy DOWN.
  // That is a correction — an OUT view was being credited with an IN posting's
  // flag, so both the movement and the accusation belonged to another day's run
  // — but nobody reading the leaderboard would connect it to an Odoo direction
  // key. is_movement is stored per row, so history is not rewritten in place.
  const odooSameDayCanon = new Set<string>();
  // 1-day late-entry buffer: postings dated runDate+1 (already in odooWindowed,
  // which spans ±1 day). A floor-confirmed movement whose only Odoo evidence is
  // a next-day posting is an "entry made late" INFO, not a REAL missing posting.
  const nextDay = addDays(runDate, 1);
  const odooNextDayCanon = new Set<string>();
  // Barcodes whose Odoo record was CREATED (create_date) on the run day itself.
  // An Odoo-only movement with a record born today that no floor source logged
  // is a genuine same-day gap (REAL); one whose record predates the run day is a
  // benign late batch-post of an earlier movement (INFO).
  const odooCreatedTodayCanon = new Set<string>();
  // Direction-keyed CUSTOMER-flow Odoo rows (sale order present and not an
  // /INT/ internal-transfer reference). Vendor PO receipts carry no SO —
  // serials are born in Odoo at receipt and the floor logs the truck, never
  // each serial — and internal transfers aren't per-barcode floor flows;
  // neither can be a same-day loss. Keyed per DIRECTION because views are
  // per-direction: a serial received from the vendor (IN, no SO) and delivered
  // to a customer (OUT, has SO) the same day must not let the vendor-receipt
  // leg masquerade as a customer flow. Computed from the RAW rows because the
  // display-only DT enrichment below overwrites ticket/job fields on the views.
  const odooCustomerDirCanon = new Set<string>();
  for (const r of odooWindowed) {
    const posted = parseDate(r.createdOn) ?? parseDate(r.date);
    const dirKey = `${r.direction}::${canonicalize(r.barcode)}`;
    if (posted === runDate) odooSameDayCanon.add(dirKey);
    else if (posted === nextDay) odooNextDayCanon.add(dirKey);
    if (parseDate(r.recordCreatedOn) === runDate) odooCreatedTodayCanon.add(dirKey);
    if (r.soNumber && !/\/INT\//i.test(String(r.ticketId ?? "")))
      odooCustomerDirCanon.add(`${r.direction}::${canonicalize(r.barcode)}`);
  }
  // odooCreatedToday (the REAL-eligibility flag for Odoo-only rows) is the
  // COMPOSITE gate: record born today AND a customer flow AND no floor trace
  // on nearby days. A record born today for a movement the floor documented on
  // its own earlier/later day is a backlog data entry (clerk typing up an old
  // day); a no-SO / internal-transfer row isn't a per-barcode floor flow —
  // neither is a same-day movement the floor missed.
  // Weekly-off gate: on the city's holiday nothing can physically move, so an
  // Odoo record CREATED that day is data entry about another day's movement —
  // never a same-day REAL. (Floor rows appearing on an off day still run the
  // normal ladder: activity on a closed day is exactly what should surface.)
  const offDay = isCityOff(city, runDate);
  if (offDay) {
    warnings.push(
      `${city} weekly off (${runDate}) — floor sources are expected absent; Odoo-only rows cannot be same-day REAL.`
    );
  }
  // Direction-keyed on every term. The record-born-today set was the last one
  // still keyed on the barcode alone, which left the leak alive inside the very
  // gate that decides ODOO_ONLY_TODAY — the only REAL an Odoo-only view can
  // raise. FUM3XJ19056052, BANGALORE, run date 2026-08-02, is the shape: the OUT
  // record was created that day and the IN record four business days earlier,
  // so the IN direction's entry in odooCreatedTodayCanon came from the OUT row.
  //
  // IT HAS FIRED. Over 2026-07-25…08-09, 134 of 1,972 rows carrying
  // odoo_created_today rest on a cross-direction record, and one reached rung 9
  // and was published: 2026-07-29 MUMBAI IN APC7VY26030132, a REAL/High "Odoo
  // Entry Created Today" telling the floor to confirm a movement or void the
  // entry. Its created-today came from the OUT leg while the customer-flow key
  // came from the IN leg, whose own record was born eight days earlier — the
  // benign late batch-post this flag exists to EXCLUDE. Both legs posted the
  // same day, so direction-keying odooSameDay alone does not rescue it; keying
  // this set does, and the row becomes INFO "Odoo Posting Only", which is right.
  //
  // About one false High a fortnight — the highest-severity output in the system.
  const createdTodayFlag = (canonical: string, dir: Direction) =>
    !offDay &&
    odooCreatedTodayCanon.has(`${dir}::${canonical}`) &&
    odooCustomerDirCanon.has(`${dir}::${canonical}`) &&
    !recentFloor.has(canonical);
  for (const v of Array.from(inViews.values())) {
    v.odooSameDay = odooSameDayCanon.has(`IN::${v.canonical}`);
    v.odooNextDay = odooNextDayCanon.has(`IN::${v.canonical}`);
    v.odooCreatedToday = createdTodayFlag(v.canonical, "IN");
  }
  for (const v of Array.from(outViews.values())) {
    v.odooSameDay = odooSameDayCanon.has(`OUT::${v.canonical}`);
    v.odooNextDay = odooNextDayCanon.has(`OUT::${v.canonical}`);
    v.odooCreatedToday = createdTodayFlag(v.canonical, "OUT");
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

  // Rows accumulate WITHOUT `reported` — it is uniform across the run and is
  // stamped once below, after every path (including the direction-conflict
  // push and the bulk-SO rewrite) has finished contributing.
  const variances: Omit<VarianceRowOut, "reported">[] = [];

  // DONE-TASKS-ONLY, part two (owner's rule, 2026-08-01). Not-done rows were
  // excluded from the views above — they never raise a variance and never stand
  // in for presence. But they still carry one load-bearing fact: the task was
  // ATTEMPTED and failed, so the guard's gate entry for the same unit (the
  // register hard-codes "done" — it means "crossed the gate", not "delivery
  // succeeded") must not surface as a gate-only loss. Suppress that leg.
  //
  // This retires two variance names that used to be RAISED here —
  // FAILED_DELIVERY ("Unclosed Return") and SHEET_NOT_DONE_BUT_POSTED
  // ("Ghost Dispatch"). Both were built on not-done rows, and the owner's rule
  // is explicit: reconciliation checks that COMPLETED movements are marked
  // correctly everywhere; a task that did not happen is not a variance. Where
  // Odoo posted a movement the floor marked not-done, the posting now grades
  // through the ordinary Odoo-only branches (INFO), not as a REAL.
  for (const r of notDoneRows) {
    suppressed.add(`${r.direction}::${canonicalize(r.barcode)}`);
  }

  // THE RETURN LEG OF A FAILED DELIVERY (owner, 2026-08-05).
  //
  // Suppressing the failed leg alone is half the rule. A delivery marked "Not
  // Delivered" comes BACK to the warehouse, and ops write that return as an
  // inward row — genuinely "Received", genuinely done. But the unit never
  // completed its outward journey, so Odoo still holds it In Transit and there
  // is no inward posting to find, no DT scan of a delivery that did not happen.
  // The ladder then reads the return as an ops-sheet-only or floor-only loss
  // and raises a REAL against it.
  //
  // Measured over the 8 days to 2026-08-05: 202 units had an outward leg that
  // failed outright, 189 of them carried the matching return, and 157 of those
  // returns were raised — around twenty false REAL chase items a day, every one
  // of them complaining that Odoo lacks an inward it was never going to have.
  //
  // OUTWARD-ONLY, deliberately. A failed PICKUP means nothing arrived, so there
  // is no outward leg to suppress; inverting this would silence real dispatches.
  // And only where the outward leg failed OUTRIGHT — notDoneRows has already had
  // done-wins applied, so a unit any source marked done is not in here at all.
  //
  // Suppressed, not deleted: the unit still counts as a movement, still appears
  // in the ledger and still shows in the four-way check. Only the accusation is
  // withheld.
  const failedOutward = new Set<string>();
  for (const r of notDoneRows) {
    if (r.direction === "OUT") failedOutward.add(canonicalize(r.barcode));
  }
  const returnLegs = new Set<string>();
  for (const canon of failedOutward) {
    const k = `IN::${canon}`;
    if (inViews.has(canon) && !suppressed.has(k)) {
      suppressed.add(k);
      returnLegs.add(k);
    }
  }
  if (returnLegs.size > 0) {
    warnings.push(
      `${returnLegs.size} inward leg${returnLegs.size === 1 ? "" : "s"} suppressed as the return of a failed delivery (the unit is still in transit in Odoo)`
    );
  }

  // ODOO'S ECHO OF A MOVEMENT THE FLOOR ALREADY SETTLED (owner, 2026-08-10).
  //
  // Odoo is windowed ±1 day (odoo-window.ts) so that a next-day posting still
  // MATCHES the day it belongs to. The side effect is that one posting row is
  // pulled into three consecutive runs, and on the two neighbouring days it has
  // no floor company — so it grades as an Odoo-only row and files a variance
  // against a movement that was reconciled on its own day, days ago.
  //
  // Traced end to end on FU95BF21033029 (Mumbai). The ledger has the guard and
  // the ops sheet logging that unit on 26 Jul, 29 Jul and 1 Aug. One Odoo
  // posting then appears and the window pulls it into the 3, 4 and 5 August
  // runs: CLEAN, REAL, CLEAN. The same Odoo row, three days, and a chase item
  // raised on the one day in the middle — for a unit the floor had recorded
  // three times already.
  //
  // Measured by replaying the whole retained window on 2026-08-10: 941 open
  // "Odoo Posting Only" rows became 308. Nine REAL rows across seven days also
  // change, every one of them a unit the floor documented on a nearby day —
  // five demote to "Entry Dated Wrong Day", three are Odoo-only echoes of the
  // kind described here, and one was a television packing box.
  //
  // recentFloor is exactly the evidence required — canonical barcodes a FLOOR
  // source logged on runDate−3 … runDate+1, excluding the run day. It already
  // gates odooCreatedToday (a record born today for a floor-documented earlier
  // movement is a backlog entry, never a REAL). This carries the same fact one
  // step further: with the floor's own record sitting on its own day, there is
  // nothing to report here at all.
  //
  // NARROW ON PURPOSE, and provably incapable of hiding a loss:
  //   * only the Odoo-ONLY presence pattern, so a unit any floor book saw today
  //     grades normally;
  //   * only on POSITIVE evidence. An Odoo-only row whose unit the floor never
  //     logged anywhere nearby still fires — that is the one that might be a
  //     phantom posting;
  //   * the only REAL an Odoo-only view can produce is ODOO_ONLY_TODAY, whose
  //     own gate (createdTodayFlag, above) already requires
  //     !recentFloor.has(canonical). So every row this removes was INFO.
  //
  // A SEPARATE SET, NOT `suppressed`. detectDirectionConflicts skips any pair
  // with a suppressed leg, so folding these keys into `suppressed` would also
  // silence a REAL same-day-replacement CROSS row. The two consumers below are
  // the ladder (skip) and the ledger (record it as suppressed, with a reason) —
  // nothing else.
  const nearbyEcho = new Set<string>();
  if (recentFloor.size > 0) {
    const markEchoes = (views: Map<string, BarcodeView>, direction: Direction) => {
      for (const v of Array.from(views.values())) {
        const odooOnly = v.O.present && !v.P.present && !v.S.present && !v.D.present;
        // AND the posting is dated the run day, which is what rung 9 requires
        // before it will judge an Odoo-only view at all. Without this clause the
        // set also swallows the ±1 match-targets — views that were never going
        // to be judged on this day — and "suppressed" would then mean something
        // weaker in the ledger than it means everywhere else. Measured on the
        // retained window: 6,347 views without the clause, 871 with it, and the
        // rows actually withheld are identical either way.
        if (!odooOnly || !v.odooSameDay || !recentFloor.has(v.canonical)) continue;
        nearbyEcho.add(`${direction}::${v.canonical}`);
      }
    };
    markEchoes(inViews, "IN");
    markEchoes(outViews, "OUT");
    if (nearbyEcho.size > 0) {
      warnings.push(
        `${nearbyEcho.size} Odoo-only posting${nearbyEcho.size === 1 ? "" : "s"} not judged — the floor documented the unit on a nearby day, where it was already reconciled`
      );
    }
  }

  let latePostings = 0;
  const classifyViews = (views: Map<string, BarcodeView>, direction: Direction) => {
    for (const v of Array.from(views.values())) {
      const k = `${direction}::${v.canonical}`;
      if (silentOcr.has(k)) continue; // never output (Section 7/12)
      if (suppressed.has(k)) continue;
      // Before the duplicate leg too: an Odoo-only echo posted twice in Odoo is
      // twice the same echo, not a duplicate scan anyone should chase.
      if (nearbyEcho.has(k)) continue;

      const hit = classify(v, reported);
      if (hit) {
        // Date-misalignment echo: a SINGLE-source-only row whose unit the floor
        // documented on an adjacent day (register page spanning two days, a
        // late write-up) is not a missing entry — demote to the INFO
        // wrong-day class. Applies only to the X-only patterns; multi-source
        // REALs (e.g. floor+DT agree, Odoo missing) keep their day's meaning.
        const soloOnly =
          hit.variance_name === VARIANCE.GATE_ONLY ||
          hit.variance_name === VARIANCE.SHEET_ONLY ||
          hit.variance_name === VARIANCE.DT_ONLY;
        const echo = soloOnly && recentFloor.has(v.canonical);

        // THE ENTRY IS ALREADY MADE (owner + Bangalore ops, 2026-08-10).
        //
        // Every rung below accuses somebody of not posting to Odoo. That
        // accusation is simply false when Odoo demonstrably holds the unit and
        // merely posted it a few days after the goods moved — and for one whole
        // flow it is false EVERY TIME.
        //
        // Vendor PO receipts are booked in a batch two days after the truck
        // lands. Measured 2026-08-10: of 162 Bangalore "PO Inward" sheet rows on
        // 6 August, ALL 162 had an Odoo receipt — 157 posted +2 days, 5 posted
        // +3. The pull window is ±1, so not one of them could ever match, and
        // the warehouse got 162 REAL chase items telling it to post entries the
        // purchase team had already posted. Traced on FUIKLV26080001: ops sheet
        // 6 Aug "PO Inward" PO-BAN-778 Received, Odoo BAN/IN/23314 created 8 Aug.
        //
        // recentOdoo is history read from the database, NOT a wider pull: the
        // ±1 window governs what counts as PRESENT for the day and must not
        // move, or three days of postings would collapse into one day's
        // presence flags and the four-way check would start lying.
        //
        // Direction-keyed, so an outward posting can never excuse a missing
        // inward one. Positive evidence only: a unit Odoo has never posted keeps
        // its REAL row, which is the case that actually means something.
        const odooBlamed =
          hit.variance_name === VARIANCE.FLOOR_DT_NOT_ODOO ||
          hit.variance_name === VARIANCE.GATE_OPS_NO_DT_ODOO ||
          hit.variance_name === VARIANCE.GATE_ONLY ||
          hit.variance_name === VARIANCE.SHEET_ONLY ||
          hit.variance_name === VARIANCE.PICKUP_ODOO_OPEN;
        const postedLate = odooBlamed && !v.O.present && recentOdoo.has(k);

        const name = postedLate
          ? VARIANCE.ODOO_POSTED_LATE
          : echo
            ? VARIANCE.ADJACENT_DAY
            : hit.variance_name;
        variances.push(
          applyBucket({
            ...baseRow(v),
            direction,
            variance_name: name,
            priority: postedLate || echo ? "Info" : hit.priority,
          })
        );
        if (postedLate) latePostings++;
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
  if (latePostings > 0) {
    warnings.push(
      `${latePostings} "not in Odoo" finding${latePostings === 1 ? "" : "s"} downgraded — Odoo posted the unit within ${3} days either side, so the entry is made`
    );
  }

  // Bulk-flow collapse: ONE sale order posted as MANY Odoo-only-created-today
  // units is a single business event (a vendor truck received / a B2B bulk
  // dispatch — measured 2026-07-21: one 157-unit ALTSTAR SO plus ZIOR receipt
  // batches produced 377 separate HIGH rows). Keep ONE representative REAL
  // chase item per (direction, SO) group and fold the rest into the INFO
  // Odoo-only tally — a genuinely unverified bulk movement still surfaces,
  // exactly once, with the unit count on the representative row.
  const BULK_SO_MIN = 5;
  {
    const groups = new Map<string, number[]>();
    variances.forEach((v, i) => {
      if (v.variance_name !== VARIANCE.ODOO_ONLY_TODAY) return;
      const so = v.so_number?.trim();
      if (!so) return;
      const k = `${v.direction}::${so.toUpperCase()}`;
      const list = groups.get(k) ?? [];
      list.push(i);
      groups.set(k, list);
    });
    for (const idxs of Array.from(groups.values())) {
      if (idxs.length < BULK_SO_MIN) continue;
      const rep = variances[idxs[0]];
      variances[idxs[0]] = {
        ...rep,
        note: `${rep.note} This SO covers ${idxs.length} units posted together — verify the bulk movement once; the other units are tallied under INFO.`,
      };
      for (const i of idxs.slice(1)) {
        const row = variances[i];
        // Every field of the row is listed explicitly here rather than spread,
        // and that is deliberate: applyBucket's parameter type makes an omitted
        // field a build error, so this rebuild cannot silently drop one. Do not
        // convert it to `...row` — the explicit list IS the safety net.
        variances[i] = applyBucket({
          barcode: row.barcode,
          barcode_display: row.barcode_display,
          city: row.city,
          direction: row.direction,
          variance_name: VARIANCE.ODOO_ONLY,
          priority: "High",
          ticket_id: row.ticket_id,
          so_number: row.so_number,
          customer: row.customer,
          product: row.product,
          job_type: row.job_type,
          date: row.date,
          // Carried through, not re-derived: the view is out of scope here and
          // the row already holds the emit-time truth for this barcode.
          present: row.present,
          note: `Part of a ${idxs.length}-unit bulk posting on SO ${row.so_number} — represented by a single chase item.`,
        });
      }
    }
  }

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

  // Stamp which SOURCES reported for this city+run onto every row. Per-row
  // presence ("did this source see the unit") was set at emit time; this is the
  // coverage mask ("did this source report at all"), and the UI needs both — a
  // source that was DOWN must render as "no data", never as a cross blaming it
  // for an absence it never had the chance to fill.
  //
  // Deliberately after the direction-conflict push and the bulk-SO rewrite, so
  // it covers every row including the paths that bypass applyBucket; and before
  // the real/info split below, which holds references into this array.
  const stamped: VarianceRowOut[] = variances.map((v) => ({ ...v, reported }));

  // Section 9 — count layer per direction.
  const count_in = computeCountLayer(countByDir("IN"), runDate);
  const count_out = computeCountLayer(countByDir("OUT"), runDate);

  // Summary.
  const real_variances = stamped.filter((v) => v.bucket === "REAL");
  const info_variances = stamped.filter((v) => v.bucket === "INFO");
  // Reconciliation universe size = distinct barcodes THIS day actually moved
  // per direction (the leaderboard accuracy denominator). Views whose only
  // evidence is an adjacent-day Odoo posting are match-targets, not today's
  // movements — counting them let one Odoo batch-post inflate a city's
  // denominator ~10x (BAN 2026-07-20: 1231 "movements" for a ~130-row floor).
  const isMovement = (v: BarcodeView) =>
    v.P.present || v.S.present || v.D.present || v.odooSameDay;
  const movements =
    Array.from(inViews.values()).filter(isMovement).length +
    Array.from(outViews.values()).filter(isMovement).length;
  const by_variance: Record<string, number> = {};
  for (const v of stamped) {
    by_variance[v.variance_name] = (by_variance[v.variance_name] ?? 0) + 1;
  }

  // Section 15 — the movement ledger (migration 0015).
  //
  // `variances` records only problems, so a unit that moved cleanly leaves no
  // trace anywhere except the `movements` integer just above. This emits one
  // row per view regardless of outcome, which is what makes a barcode's history
  // answerable beyond the 7-day source_rows window.
  //
  // Placed HERE, at the end of the run, for three reasons that each rule out an
  // earlier site:
  //   * presenceOf(v) must be read after mergeGuardPresence has mutated P
  //     during the OCR-orphan fold — earlier, and a merged unit reports "no
  //     gate record", the exact false negative the merge exists to remove;
  //   * `stamped` is only final after the bulk-SO rewrite and the
  //     direction-conflict push, so an earlier build would record variance
  //     names that no longer exist (ODOO_ONLY_TODAY rather than ODOO_ONLY);
  //   * isMovement is defined immediately above and must not be duplicated —
  //     it is the leaderboard's accuracy denominator.
  const hitsByKey = new Map<string, VarianceRowOut[]>();
  for (const v of stamped) {
    // A CROSS row asserts one unit both arrived AND left today, so it belongs
    // to both legs; the evidence for the claim is the union of the two.
    const dirs: Direction[] = v.direction === "CROSS" ? ["IN", "OUT"] : [v.direction];
    for (const d of dirs) {
      const k = `${d}::${v.barcode}`;
      hitsByKey.set(k, [...(hitsByKey.get(k) ?? []), v]);
    }
  }

  const PRIORITY_ORDER: Priority[] = ["High", "Medium", "Info"];
  const worstPriority = (hits: VarianceRowOut[]): Priority | null => {
    for (const p of PRIORITY_ORDER) if (hits.some((h) => h.priority === p)) return p;
    return null;
  };

  const movement_events: MovementEvent[] = [];
  const collectEvents = (views: Map<string, BarcodeView>, direction: Direction) => {
    for (const v of views.values()) {
      const k = `${direction}::${v.canonical}`;
      const hits = hitsByKey.get(k) ?? [];
      // A hit wins over suppression: the failed-delivery pass adds an OUT key to
      // `suppressed` AND pushes a variance, so testing suppression first would
      // mislabel a real finding as silence.
      const outcome: MovementEvent["outcome"] =
        hits.length > 0
          ? hits.some((h) => h.bucket === "REAL")
            ? "REAL"
            : "INFO"
          : silentOcr.has(k) || suppressed.has(k) || nearbyEcho.has(k)
            ? "SUPPRESSED"
            : "CLEAN";
      movement_events.push({
        barcode: v.canonical,
        barcode_display: displayBarcode(v),
        city,
        direction,
        // The city's DERIVED run date, which is what upsertVariances writes as
        // business_date. If these ever diverge the ledger and the variances key
        // on different dates and stop joining.
        date: v.date || runDate,
        present: presenceOf(v),
        reported,
        odooSameDay: v.odooSameDay,
        odooNextDay: v.odooNextDay,
        odooCreatedToday: v.odooCreatedToday,
        isMovement: isMovement(v),
        jobType: v.jobType,
        soNumber: v.soNumber,
        ticketId: v.ticketId,
        customer: v.customer,
        product: v.product,
        outcome,
        varianceNames: hits.map((h) => h.variance_name),
        worstPriority: worstPriority(hits),
        suppressedReason:
          outcome !== "SUPPRESSED"
            ? null
            : returnLegs.has(k)
              ? "failed_delivery_return"
              : silentOcr.has(k)
                ? "silent_ocr"
                : dtAllPending.has(k)
                  ? "dt_all_pending"
                  : nearbyEcho.has(k)
                    ? "odoo_nearby_day"
                    : "other",
      });
    }
  };
  collectEvents(inViews, "IN");
  collectEvents(outViews, "OUT");

  return {
    city,
    date: runDate,
    variances: stamped,
    real_variances,
    info_variances,
    count_in,
    count_out,
    movement_events,
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
  // Cities whose reconciliation threw (bad dates with no fallback, etc.) —
  // isolated so one broken city can never take down the other four.
  skipped: { city: City; error: string }[];
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
  reportedByCity?: Partial<Record<City, ReportedSources>>,
  recentFloorByCity?: Partial<Record<City, ReadonlySet<string>>>,
  fallbackDate?: string,
  recentOdooByCity?: Partial<Record<City, ReadonlySet<string>>>
): MultiCityRun {
  const perCity: CityRunResult[] = [];
  const skipped: { city: City; error: string }[] = [];
  for (const city of CITIES) {
    const rows = rowsByCity[city];
    if (!rows || rows.length === 0) continue;
    // Per-city isolation: a city that cannot reconcile (e.g. unparseable dates
    // and no fallback) is reported as skipped — the other cities still run.
    try {
      perCity.push(
        runReconciliation(
          rows,
          city,
          reportedByCity?.[city] ?? ALL_REPORTED,
          recentFloorByCity?.[city] ?? new Set(),
          fallbackDate,
          recentOdooByCity?.[city] ?? new Set()
        )
      );
    } catch (err) {
      skipped.push({ city, error: err instanceof Error ? err.message : String(err) });
    }
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
    date: perCity[0]?.date ?? fallbackDate ?? "",
    perCity,
    skipped,
    combined: { total, real_count, info_count, high_priority, by_variance },
  };
}
