// Today's expected pickings, pulled from Odoo and cached for the phone.
//
// SERIALS ON PLANNED MOVES. Confirmed with operations 2026-08-22: every planned
// movement in Odoo carries the item's barcode, so the scan the guard makes has
// something to match against. That resolves the question this module was
// originally written around.
//
// One distinction survives it, and it is why the probe below reports BY STATE
// rather than as a single number:
//
//   assigned   reserved and ready. Odoo picks the specific unit at reservation,
//              so the lot is set and these are the rows the check relies on.
//   confirmed  waiting on stock. Nothing is reserved yet, so a lot may not
//              exist to attach — through no fault of anyone's.
//
// Both are pulled: a same-day confirmation can still go out, and a row with no
// serial is simply skipped rather than dropped silently — it is counted, so the
// size of that gap is visible instead of guessed at.
//
// EXPECTED_CHECK_LIVE stays false for the pilot anyway, for a DIFFERENT reason
// than Odoo coverage: an item added to a load without any planned picking at
// all would warn even against a perfect list. Whether that happens often is an
// operational question, not a data one, and silent mode is how it gets answered
// before a guard is taught to dismiss warnings.
//
// REFRESHED ON DEMAND, NOT AT DAWN — changed 2026-08-25 after measuring it.
//
// It used to be a 07:00 snapshot. That produced 17 rows for a day in which Odoo
// records roughly 1,451 movements, and — the telling part — ZERO rows for
// tomorrow, every day, even though the job explicitly asks for tomorrow too.
//
// Odoo pickings here are not planned in advance. They are created during the
// day and pass through 'assigned'/'confirmed' to 'done' quickly, so a snapshot
// taken at 07:00 can only ever catch the handful that happen to be pending at
// 07:00. That is not a bug in the query; it is the wrong mechanism for how the
// business actually uses Odoo. A completeness check built on it would have told
// a guard that almost everything they scanned was "not on the list".
//
// So the list is refreshed when it is ASKED FOR and found stale, which is the
// same conclusion the DT pull reached for the same reason. The overnight job
// stays as a warm start; it is no longer the only writer.
//
// Odoo goes through Metabase and takes seconds, so this can never sit on the
// scanning path. It runs in the background when the app opens, and again at
// trip close — the moment the answer is actually used, and a moment the guard
// has already stopped moving.

import type { SupabaseClient } from "@supabase/supabase-js";
import { metabaseConfigured, runNativeSql } from "../connectors/metabase";
import { normalizeOdooWarehouse } from "../connectors/odoo-mapping";
import { businessDayToUtcWindow } from "../connectors/ist-window";
import { canonicalize } from "../engine/barcode";
import { fetchDtExpected, toExpectedRow } from "./expected-dt";
import type { City } from "../sample-data";
import type { Direction } from "../engine/types";

/** Ceiling for this query — it is optional to the run and must never eat the
 *  function budget the way an unbounded Metabase call can. */
const TIMEOUT_MS = 20_000;

/**
 * Pickings that are READY OR CONFIRMED but not yet done, scheduled for the day.
 *
 * `assigned` is "reserved and ready to pick" and is the state that matters;
 * `confirmed` is "waiting on stock" and is included because a same-day
 * confirmation can still go out. `done` is deliberately excluded — a completed
 * move is history, and the gate is asking what is still to come.
 */
function buildQuery(startUtc: string, endUtcExclusive: string): string {
  const start = startUtc.slice(0, 19).replace("T", " ");
  const end = endUtcExclusive.slice(0, 19).replace("T", " ");
  return `
SELECT
    sl.name                       AS barcode,
    pt.name ->> 'en_US'           AS product,
    so.name                       AS so_number,
    sml.reference                 AS ticket_id,
    rp.name                       AS customer,
    sp.name                       AS picking_ref,
    sw.code                       AS warehouse_code,
    sml.movement_type             AS direction,
    sml.procurement_status        AS job_type,
    sml.state                     AS move_state
FROM stock_move_line sml
JOIN stock_picking          sp   ON sp.id  = sml.picking_id
JOIN stock_picking_type     spt  ON spt.id = sp.picking_type_id
JOIN stock_warehouse        sw   ON sw.id  = spt.warehouse_id
JOIN product_product        pp   ON pp.id  = sml.product_id
JOIN product_template       pt   ON pt.id  = pp.product_tmpl_id
-- LEFT, not JOIN: an unassigned serial is the case we need to SEE rather than
-- silently filter away. Rows with no lot are dropped in TS and counted, so the
-- coverage probe below can report how big that hole actually is.
LEFT JOIN stock_lot         sl   ON sl.id  = sml.lot_id
LEFT JOIN sale_order        so   ON so.id  = sml.sale_order_id
LEFT JOIN res_partner       rp   ON rp.id  = sp.partner_id
WHERE
    sml.state IN ('assigned','confirmed')
    AND sp.scheduled_date >= '${start}'
    AND sp.scheduled_date <  '${end}'
    AND sml.movement_type IN ('In','Out')
ORDER BY sp.scheduled_date ASC;
`.trim();
}

export interface ExpectedRow {
  city: City;
  direction: Direction;
  barcode: string;
  product: string | null;
  soNumber: string | null;
  ticketId: string | null;
  customer: string | null;
  pickingRef: string | null;
  jobType: string | null;
}

export interface ExpectedPull {
  rows: ExpectedRow[];
  /** Planned lines whose serial is not yet assigned — the coverage hole. */
  withoutSerial: number;
  total: number;
  /** Per Odoo state, because `assigned` and `confirmed` behave differently. */
  byState: Record<string, { total: number; withSerial: number }>;
}

export async function fetchExpected(businessDate: string): Promise<ExpectedPull> {
  if (!metabaseConfigured()) throw new Error("Metabase is not configured");
  const dbId = Number(process.env.METABASE_ODOO_DB_ID);
  if (!Number.isFinite(dbId)) throw new Error("METABASE_ODOO_DB_ID is not set");

  const { startUtc, endUtcExclusive } = businessDayToUtcWindow(businessDate);
  const table = await runNativeSql(dbId, buildQuery(startUtc, endUtcExclusive), TIMEOUT_MS);

  const rows: ExpectedRow[] = [];
  const byState: Record<string, { total: number; withSerial: number }> = {};
  let withoutSerial = 0;
  for (const r of table.rows) {
    const city = normalizeOdooWarehouse(r.warehouse_code);
    if (!city) continue;
    const st = String(r.move_state ?? "unknown");
    (byState[st] ??= { total: 0, withSerial: 0 }).total++;
    const barcode = String(r.barcode ?? "").trim();
    if (!barcode) { withoutSerial++; continue; }
    byState[st].withSerial++;
    const direction: Direction | null =
      r.direction === "In" ? "IN" : r.direction === "Out" ? "OUT" : null;
    if (!direction) continue;
    rows.push({
      city, direction, barcode,
      product: (r.product as string) ?? null,
      soNumber: (r.so_number as string) ?? null,
      ticketId: (r.ticket_id as string) ?? null,
      customer: (r.customer as string) ?? null,
      pickingRef: (r.picking_ref as string) ?? null,
      jobType: (r.job_type as string) ?? null,
    });
  }
  return { rows, withoutSerial, total: table.rows.length, byState };
}

/** Replace a day's cache. Delete-then-insert so a picking that was cancelled
 *  disappears rather than lingering as a phantom expectation. */
export async function refreshExpected(
  admin: SupabaseClient,
  businessDate: string
): Promise<{ written: number; withoutSerial: number; total: number; kept?: true;
             dtWritten?: number; dtSkipped?: { unknownCity: number; ambiguousDirection: number } }> {
  const pull = await fetchExpected(businessDate);

  // AN EMPTY PULL NEVER WIPES A GOOD LIST.
  //
  // The delete below is what lets a cancelled picking disappear. It was also
  // unconditional, which meant one bad Metabase minute — a timeout, a session
  // expiry, Odoo mid-restart — would blank the day's expectations and the gate
  // would check every scan against nothing. Silent, and indistinguishable from
  // a quiet day.
  //
  // Zero rows is not proof of zero movements; it is equally the shape of a
  // failed query. Keeping the previous list is wrong for at most one refresh
  // cycle; deleting it is wrong until somebody notices.
  if (pull.rows.length === 0) {
    const { count } = await admin
      .from("gate_expected_items")
      .select("id", { count: "exact", head: true })
      .eq("business_date", businessDate);
    if ((count ?? 0) > 0) {
      return { written: 0, withoutSerial: pull.withoutSerial, total: pull.total, kept: true };
    }
  }

  await admin.from("gate_expected_items").delete().eq("business_date", businessDate);

  const payload = pull.rows.map((r) => ({
    city: r.city,
    business_date: businessDate,
    direction: r.direction,
    barcode: r.barcode,
    // The fold alongside the true spelling, so a scanned QR still matches a row
    // whose Odoo spelling differs only by a confusable character.
    barcode_canon: canonicalize(r.barcode),
    product: r.product,
    so_number: r.soNumber,
    ticket_id: r.ticketId,
    customer: r.customer,
    picking_ref: r.pickingRef,
    job_type: r.jobType,
    planned_by: "ODOO" as const,
  }));

  let written = 0;
  for (let i = 0; i < payload.length; i += 500) {
    const chunk = payload.slice(i, i + 500);
    const { error } = await admin
      .from("gate_expected_items")
      .upsert(chunk, { onConflict: "city,business_date,direction,barcode" });
    if (error) throw new Error(`refreshExpected: ${error.message}`);
    written += chunk.length;
  }
  // ── DT, merged on top ────────────────────────────────────────────────
  // Odoo knows what the item IS; DT knows who it is FOR and where it is going.
  // Both usually name the same barcode on the same day, so this MERGES rather
  // than letting one overwrite the other: an item only DT predicted is a gap in
  // Odoo, one only Odoo predicted is a gap in DT, and one both agreed on is
  // neither. Flattened into a single list, all three look the same.
  //
  // Never allowed to fail the refresh. The list worked from Odoo alone before
  // this existed, and a bad minute at DT must cost the enrichment rather than
  // the list.
  const dt = await fetchDtExpected(businessDate).catch(
    () => ({ rows: [], skipped: { unknownCity: 0, ambiguousDirection: 0 } })
  );

  let dtWritten = 0;
  if (dt.rows.length) {
    // What Odoo already claimed, so a line both systems know can be marked
    // BOTH rather than being quietly relabelled DT by arriving second.
    const odooKeys = new Set(payload.map(
      (p) => `${p.city}|${p.direction}|${p.barcode}`
    ));

    const dtPayload = dt.rows.map((r) => {
      const row = toExpectedRow(r, businessDate);
      const agreed = odooKeys.has(`${row.city}|${row.direction}|${row.barcode}`);
      return {
        ...row,
        planned_by: agreed ? ("BOTH" as const) : ("DT" as const),
        // On a line Odoo also has, DT contributes ONLY what Odoo cannot know.
        // Overwriting the picking reference or the product with DT's version
        // would lose the identity half of the record to gain nothing.
        ...(agreed ? { product: undefined, so_number: undefined, picking_ref: undefined } : {}),
      };
    });

    for (let i = 0; i < dtPayload.length; i += 500) {
      const chunk = dtPayload.slice(i, i + 500).map((r) =>
        Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined))
      );
      const { error } = await admin
        .from("gate_expected_items")
        .upsert(chunk, { onConflict: "city,business_date,direction,barcode" });
      // A DT failure is reported, never thrown: Odoo's half is already stored.
      if (error) break;
      dtWritten += chunk.length;
    }
  }

  return {
    written, withoutSerial: pull.withoutSerial, total: pull.total,
    dtWritten, dtSkipped: dt.skipped,
  };
}

/**
 * What share of planned lines actually carry a serial, split by Odoo state.
 *
 * Reported as ratios rather than a verdict. If `confirmed` turns out to be the
 * only weak band, the fix is to stop pulling that state rather than to abandon
 * the check — and that is a decision this module should surface, not make.
 */
export async function probeExpectedCoverage(businessDate: string) {
  const p = await fetchExpected(businessDate);
  return {
    businessDate,
    plannedLines: p.total,
    withSerial: p.rows.length,
    withoutSerial: p.withoutSerial,
    coverage: p.total ? +(p.rows.length / p.total).toFixed(3) : null,
    byState: Object.fromEntries(
      Object.entries(p.byState).map(([k, v]) => [
        k, { ...v, coverage: v.total ? +(v.withSerial / v.total).toFixed(3) : null },
      ])
    ),
  };
}

/* ── Keeping it fresh ──────────────────────────────────────────────────── */

/**
 * How old the cached list may be before it is worth paying for a new one.
 *
 * Ten minutes is a compromise between two real costs. Shorter and a busy gate
 * pays a multi-second Metabase query every few scans for a list that has
 * barely changed. Longer and a picking created twenty minutes ago — routine
 * here, since Odoo rows are made during the day — is still invisible at the
 * moment a guard closes the trip it belongs to.
 */
export const EXPECTED_MAX_AGE_MS = 10 * 60_000;

/**
 * One refresh at a time per running instance.
 *
 * Three phones at shift change hit the app within seconds of each other. Each
 * would otherwise start its own Metabase query against a list they are all
 * going to share, tripling the load on the slowest dependency in the system to
 * produce three identical answers. Whoever asks first does the work; the rest
 * wait on the same promise.
 *
 * Per-instance rather than global. A distributed lock would need another round
 * trip to take, and the failure it prevents — two instances refreshing the same
 * day at once — costs one duplicated query and leaves the data correct either
 * way. Not worth the machinery.
 */
const inFlight = new Map<string, Promise<void>>();

/** When was this day's list last written? Null if there is no list at all. */
async function cacheAge(admin: SupabaseClient, businessDate: string): Promise<number | null> {
  const { data } = await admin
    .from("gate_expected_items")
    .select("refreshed_at")
    .eq("business_date", businessDate)
    .order("refreshed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const at = data?.refreshed_at as string | undefined;
  if (!at) return null;
  const ms = Date.now() - Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

export interface FreshResult {
  refreshed: boolean;
  /** Why not, when it did not — so a caller can log something more useful
   *  than silence, and a stale list is never mistaken for a current one. */
  reason?: "fresh" | "unconfigured" | "failed" | "in-progress";
  ageMs?: number | null;
}

/**
 * Make sure the day's expected list is current enough to check a trip against.
 *
 * NEVER THROWS, and never blocks anything a guard is waiting on. The list is an
 * aid to a check that is still silent; Odoo being slow or unreachable must cost
 * at most the freshness of a warning, never the ability to record a movement.
 * Callers that are on a guard's path should not await it at all.
 */
export async function ensureExpectedFresh(
  admin: SupabaseClient,
  businessDate: string,
  maxAgeMs: number = EXPECTED_MAX_AGE_MS
): Promise<FreshResult> {
  if (!metabaseConfigured()) return { refreshed: false, reason: "unconfigured" };

  const existing = inFlight.get(businessDate);
  if (existing) { await existing.catch(() => {}); return { refreshed: false, reason: "in-progress" }; }

  // THE AGE CHECK LIVES INSIDE THE CLAIMED JOB, and that is not a stylistic
  // choice. Reading the age first meant an `await` sat between asking whether
  // anyone was already refreshing and saying that we were — so three phones
  // arriving together all read "nobody is", all claimed, and all queried
  // Metabase. Creating the promise and registering it happen with no await
  // between them, which is what actually makes this single-flight.
  let outcome: FreshResult = { refreshed: false, reason: "failed" };
  const job = (async () => {
    const age = await cacheAge(admin, businessDate).catch(() => null);
    // A day with no list at all is always worth fetching, however recently we
    // may have tried — that is the state a new business day starts in.
    if (age !== null && age < maxAgeMs) {
      outcome = { refreshed: false, reason: "fresh", ageMs: age };
      return;
    }
    await refreshExpected(admin, businessDate);
    outcome = { refreshed: true, ageMs: age };
  })();

  inFlight.set(businessDate, job);
  try {
    await job;
    return outcome;
  } catch {
    return { refreshed: false, reason: "failed" };
  } finally {
    inFlight.delete(businessDate);
  }
}
