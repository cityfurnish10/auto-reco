// "What happened to this unit?" — the tool the chat exists for.
//
// It reads four things, and the fourth is the one that keeps it honest:
//   A. flagged items for the barcode, all dates          (variances)
//   B. per-system records inside the retention window    (source_rows)
//   C. whether each connector reported on those city-days (run_city_stats)
//   D. the retention floor                                (source_rows min)
//
// C matters because a source that was DOWN must never be described as a source
// that had no record — one is the absence of evidence, the other is evidence.
// The detail modal's coverage probe answers the same question, but it needs a
// run_id and only works inside the window; run_city_stats.reported_* still
// answers it after the raw rows are pruned.
//
// D matters because "no rows" and "we no longer hold that" are different
// answers, and only one of them is true before the floor.

import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalize, isValidBarcode, isPpBox, isSpareOrConsumable } from "../../engine/barcode";
import {
  DIRECTION_WORDS,
  describeEvidence,
  describeFlag,
  describeOrder,
  type ToolStatus,
} from "../grounding";
import type { ToolContext } from "./context";
import { sanitizeFreeText } from "../sanitize";

const MAX_FLAGGED = 20;
const MAX_SOURCE_ROWS = 40;
/**
 * How many recent runs to resolve when scoping the raw feed to one per date.
 *
 * source_rows is pruned at 7 days and a date is reconciled a handful of times,
 * so this comfortably spans the retained window with room for re-runs.
 */
const RUN_LOOKUP_LIMIT = 200;
const MAX_DAYS = 8;

// The typed client cannot infer a select() built by string concatenation, so
// the shapes are declared and the results cast once.
interface FlaggedRow {
  business_date: string;
  /** Migration 0020 — absent on older rows, so every read of it is optional. */
  barcode_display?: string | null;
  city: string;
  direction: string;
  variance_name: string;
  bucket: string | null;
  status: string;
  responsible: string | null;
  job_type: string | null;
  so_number: string | null;
  ticket_id: string | null;
  product: string | null;
  customer: string | null;
  present_p?: boolean | null;
  present_s?: boolean | null;
  present_d?: boolean | null;
  present_o?: boolean | null;
  reported_p?: boolean | null;
  reported_s?: boolean | null;
  reported_d?: boolean | null;
  reported_o?: boolean | null;
}

interface SourceRowLite {
  business_date: string;
  city: string;
  source: string;
  direction: string;
  status: string | null;
  so_number: string | null;
  ticket_id: string | null;
  product: string | null;
  job_type: string | null;
}

interface JourneyDay {
  date: string;
  city: string;
  movement: string;
  recordedBy: string[];
  noEntryIn: string[];
  cannotJudge: string[];
  evidenceHeld: boolean;
  flagged: ReturnType<typeof describeFlag>[];
  order: Record<string, string>;
}

export interface JourneyResult {
  status: ToolStatus;
  /** The spelling shown to the user — what a typed source recorded. */
  barcode?: string;
  /** The canonical it matched on, so a follow-up can look it up again. */
  matchedAs?: string;
  detailHeldFrom?: string | null;
  days?: JourneyDay[];
  truncated?: boolean;
  checked?: string[];
  message?: string;
}

export async function findBarcodeJourney(
  sb: SupabaseClient,
  args: { barcode?: string; city?: string },
  ctx: ToolContext
): Promise<JourneyResult> {
  const raw = String(args.barcode ?? "").slice(0, 64).trim();
  if (!raw || !isValidBarcode(raw)) {
    return { status: "invalid_barcode", message: `"${raw}" is not a barcode we would track.` };
  }
  if (isPpBox(raw) || isSpareOrConsumable(raw)) {
    return {
      status: "count_only",
      barcode: raw,
      message: "Packing boxes and spares are counted in bulk, never tracked unit by unit.",
    };
  }
  if (args.city && !ctx.visibleCities.includes(args.city)) {
    return { status: "city_not_visible", message: `You can only see ${ctx.visibleCities.join(", ")}.` };
  }

  // variances.barcode is canonical, so this is the right key — and it is better
  // than the portal's own free-text search, which does ilike against canonical
  // values and therefore misses a raw barcode containing O, I, S, Z or G.
  const canon = canonicalize(raw);

  // Built twice, not once: barcode_display is migration 0020 and migrations here
  // are applied by hand, so a database one behind must still answer the journey.
  const FLAGGED_COLS =
    "business_date, city, direction, variance_name, bucket, status, responsible, job_type," +
    " so_number, ticket_id, product, customer," +
    " present_p, present_s, present_d, present_o," +
    " reported_p, reported_s, reported_d, reported_o";
  const flaggedQuery = (cols: string) =>
    sb
      .from("variances")
      .select(cols)
      .eq("barcode", canon)
      .order("business_date", { ascending: false })
      .order("id", { ascending: true })
      .limit(MAX_FLAGGED);
  const flaggedQ = flaggedQuery(`${FLAGGED_COLS}, barcode_display`);

  // ONE RUN PER DATE. source_rows keeps the raw feed of EVERY run, and a date
  // is reconciled many times — the nightly cron, the D-3 re-check sweep, any
  // manual re-run — each inserting a fresh copy of the same rows. Unscoped, a
  // unit's journey listed one Odoo record twelve times for a single day
  // (measured 2026-08-02 on 0TEPQU24021023: 56 rows for 6 real records), and
  // the duplicates ate the MAX_SOURCE_ROWS budget so genuinely older days fell
  // off the end. Every other reader of the raw tables already scopes this way.
  const runIdsRes = await sb
    .from("reconciliation_runs")
    .select("id, business_date")
    .in("status", ["success", "partial"])
    .order("business_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(RUN_LOOKUP_LIMIT);
  const latestRunPerDate = new Map<string, string>();
  for (const r of (runIdsRes.data ?? []) as { id: string; business_date: string }[]) {
    // The ordering above puts each date's newest run first.
    if (!latestRunPerDate.has(r.business_date)) latestRunPerDate.set(r.business_date, r.id);
  }
  const runIds = [...latestRunPerDate.values()];

  let sourceQ = sb
    .from("source_rows")
    .select("business_date, city, source, direction, status, so_number, ticket_id, product, job_type")
    .eq("barcode_canonical", canon);
  // No runs readable (or the table unreachable) — fall back to unscoped rather
  // than returning nothing. A journey with repeats beats no journey.
  if (runIds.length > 0) sourceQ = sourceQ.in("run_id", runIds);
  const sourceRes = await sourceQ
    .order("business_date", { ascending: false })
    .order("id", { ascending: true })
    .limit(MAX_SOURCE_ROWS);

  let flaggedRes = await flaggedQ;
  // Pre-0020 database: retry without the display column rather than failing the
  // whole journey over a label.
  if (
    flaggedRes.error &&
    (flaggedRes.error.code === "42703" || flaggedRes.error.code === "PGRST204" ||
      /does not exist|could not find/i.test(flaggedRes.error.message ?? ""))
  ) {
    flaggedRes = await flaggedQuery(FLAGGED_COLS);
  }

  if (flaggedRes.error) return { status: "lookup_failed", message: flaggedRes.error.message };

  // Migration 0014 may not be applied; the journey is still useful without the
  // per-system rows, so degrade rather than fail.
  const sourceRows = (sourceRes.error ? [] : (sourceRes.data ?? [])) as unknown as SourceRowLite[];
  const flagged = (flaggedRes.data ?? []) as unknown as FlaggedRow[];

  if (flagged.length === 0 && sourceRows.length === 0) {
    return {
      status: "no_detail_retained",
      barcode: canon,
      detailHeldFrom: ctx.detailHeldFrom,
      checked: [
        `day-by-day system records back to ${ctx.detailHeldFrom ?? "the retention floor"}`,
        "flagged items across all retained dates",
        "anything still unresolved, whatever its date",
      ],
    };
  }

  // One entry per (date, city, direction) across both sources.
  const byKey = new Map<string, JourneyDay>();
  const keyOf = (d: string, c: string, dir: string) => `${d}|${c}|${dir}`;

  for (const f of flagged) {
    const k = keyOf(f.business_date, f.city, f.direction);
    const ev = describeEvidence(f);
    const day: JourneyDay = byKey.get(k) ?? {
      date: f.business_date,
      city: f.city,
      movement: DIRECTION_WORDS[f.direction] ?? f.direction,
      recordedBy: ev.recordedBy,
      noEntryIn: ev.noEntryIn,
      cannotJudge: ev.cannotJudge,
      evidenceHeld: ev.evidenceHeld,
      flagged: [],
      order: describeOrder(f),
    };
    day.flagged.push(describeFlag(f));
    byKey.set(k, day);
  }

  // Source rows fill in the days that raised nothing — the clean legs, which
  // are exactly what `variances` cannot tell us and the reason this tool reads
  // two tables.
  const SOURCE_NAME: Record<string, string> = {
    PHYSICAL: "gate register",
    SHEET: "ops sheet",
    DT: "delivery app",
    ODOO: "Odoo",
  };
  const sourcesByDay = new Map<string, Set<string>>();
  const firstRowByDay = new Map<string, SourceRowLite>();
  for (const s of sourceRows) {
    const k = keyOf(s.business_date, s.city, s.direction);
    sourcesByDay.set(k, (sourcesByDay.get(k) ?? new Set<string>()).add(s.source));
    if (!firstRowByDay.has(k)) firstRowByDay.set(k, s);
  }

  for (const [k, sources] of sourcesByDay) {
    if (byKey.has(k)) continue; // a flagged day already describes its own evidence
    const s = firstRowByDay.get(k)!;
    const recordedBy = [...sources].map((x) => SOURCE_NAME[x] ?? x);
    byKey.set(k, {
      date: s.business_date,
      city: s.city,
      movement: DIRECTION_WORDS[s.direction] ?? s.direction,
      // We are holding the raw rows, so this IS per-system evidence — saying
      // otherwise would under-report a clean movement into "we don't know".
      recordedBy,
      // Only the systems that recorded it are knowable from raw rows alone;
      // whether the others were up is a question for run_city_stats, and
      // guessing here would manufacture the accusation this design avoids.
      noEntryIn: [],
      cannotJudge: [],
      evidenceHeld: true,
      flagged: [],
      order: describeOrder(s),
    });
  }

  const days = [...byKey.values()].sort((a, b) => b.date.localeCompare(a.date));
  const truncated = days.length > MAX_DAYS;

  // ECHO THE SPELLING, NOT THE FOLD. The lookup above is canonical on purpose
  // (that is what lets a user paste FUMYGB… and find a row stored as FUMY6B…),
  // but answering with the fold hands back a barcode they never typed and
  // cannot find in Odoo. Prefer what a typed source recorded; fall back to the
  // user's own spelling, then the canonical.
  const spelled =
    flagged.find((r) => (r as { barcode_display?: string | null }).barcode_display)
      ?.barcode_display ?? null;
  const shown =
    sanitizeFreeText(spelled, 40) ?? sanitizeFreeText(raw.toUpperCase().replace(/\s+/g, ""), 40) ?? canon;

  return {
    status: days.some((d) => d.flagged.length > 0) ? "found" : "clean",
    barcode: shown,
    /** The key it matched on — kept so a follow-up question can look it up again. */
    matchedAs: canon,
    detailHeldFrom: ctx.detailHeldFrom,
    days: days.slice(0, MAX_DAYS),
    truncated,
  };
}
