// What a scanned serial IS, looked up from Odoo's lot master.
//
// THE RULE THIS MODULE EXISTS TO KEEP. The gate is the fourth witness, and it
// is only worth having because it is INDEPENDENT. Enriching a scan from
// gate_expected_items — the day's planned pickings — would make it agree with
// Odoo about today by construction, which is the same failure COMPLETENESS_SHOWN
// refuses in the UI, arriving through the database instead.
//
// So the Odoo lookup is deliberately narrow: given a serial, what is this unit,
// and where has it BEEN. A dictionary lookup, not a verification. The DT half
// at the bottom of this file (ticket, job type, customer) is closer to the plan,
// and is only acceptable because of where both answers are written — columns a
// manager reads and the engine and the guard never do.
//
// Measured on the first real run, 2026-09-10, over all 38 serialised scans the
// pilot had recorded:
//
//   product          38/38  100%
//   last customer    36/38   95%   real customers AND vendors (WAKEFIT
//                                  INNOVATIONS on inbound units, say) — both
//                                  are facts about the unit, both useful
//   last SO          25/38   66%
//
// An earlier note here said customer and SO resolved "about a third of the
// time". That came from hand-picking three serials, and was wrong — kept in
// this comment because the lesson is the reusable part: three rows is an
// anecdote, and this file is exactly where a made-up-sounding number does
// damage.
//
// Product is still the field to rely on, and the rest is still a chase hint
// rather than evidence — that has not changed, only the odds. Nothing here is
// written to the columns the reconciliation reads; see migration 0037 for that
// separation and why it is load bearing.

import { runMongoPipeline, runNativeSql } from "../connectors/metabase";
import { dtDatabaseId } from "./fleet";
import { utcToIstDate } from "../connectors/ist-window";

export interface UnitFacts {
  serial: string;
  product: string | null;
  sku: string | null;
  lastCustomer: string | null;
  lastSo: string | null;
  lastDirection: string | null;
  lastMovedAt: string | null;
}

/**
 * Metabase native SQL has no bind parameters, so serials are interpolated. A
 * barcode arrives from a QR code a guard pointed a camera at, which means an
 * attacker can choose its contents by printing a sticker — so this is filtered,
 * not escaped, and the filter lives INSIDE unitFactsSql rather than in a caller.
 * Safe by construction beats safe-if-called-correctly: the next person to use
 * the query builder does not have to know about the wrapper.
 *
 * A serial that is not plain alphanumerics cannot be an Odoo lot name anyway,
 * so nothing is lost by refusing to ask about it.
 */
const SAFE = /^[A-Za-z0-9._-]{4,32}$/;

/** The serials worth asking Odoo about: deduplicated, trimmed, plausible. */
export function askable(serials: string[]): string[] {
  return [...new Set(serials.map((s) => String(s ?? "").trim()).filter((s) => SAFE.test(s)))];
}

/**
 * Wall-clock ceiling. Enrichment is entirely optional: a scan without it is
 * still a complete record of a unit crossing a gate. A Metabase stall must cost
 * this lookup and nothing else — the same reasoning runNativeSql's own timeout
 * comment gives for the nightly run.
 */
const TIMEOUT_MS = 20_000;

export function odooDbId(): number {
  return Number(process.env.METABASE_ODOO_DB_ID ?? 5);
}

/**
 * DISTINCT ON picks each serial's most recent completed movement, so one query
 * answers both halves: the lot master join gives identity (always present), the
 * movement row gives the last-known context (often not). LEFT JOINs throughout
 * because a unit that has never moved still has a product, and that alone is
 * worth storing.
 */
export function unitFactsSql(serials: string[]): string {
  const safe = askable(serials);
  if (safe.length === 0) return "";
  const list = safe.map((s) => `'${s}'`).join(",");
  return `
SELECT DISTINCT ON (sl.name)
  sl.name                 AS serial,
  pt.name ->> 'en_US'     AS product,
  pt.default_code         AS sku,
  rp.name                 AS last_customer,
  so.name                 AS last_so,
  sml.movement_type       AS last_direction,
  sml.date::date          AS last_moved_at
FROM stock_lot sl
JOIN product_product  pp  ON pp.id = sl.product_id
JOIN product_template pt  ON pt.id = pp.product_tmpl_id
LEFT JOIN stock_move_line sml ON sml.lot_id = sl.id AND sml.state = 'done'
LEFT JOIN stock_picking   sp  ON sp.id = sml.picking_id
LEFT JOIN res_partner     rp  ON rp.id = sp.partner_id
LEFT JOIN sale_order      so  ON so.id = sml.sale_order_id
WHERE sl.name IN (${list})
ORDER BY sl.name, sml.date DESC NULLS LAST`.trim();
}

/**
 * Look up a batch of serials. Returns only what Odoo knew about; a serial with
 * no row simply does not appear, and the caller still marks it attempted so an
 * unknown unit is not retried forever.
 *
 * Never throws for a data reason — an empty map means "we learned nothing this
 * time", which is a normal outcome and must not fail a caller.
 */
export async function fetchUnitFacts(serials: string[]): Promise<Map<string, UnitFacts>> {
  const out = new Map<string, UnitFacts>();
  const sql = unitFactsSql(serials);
  if (sql === "") return out;

  const { rows } = await runNativeSql(odooDbId(), sql, TIMEOUT_MS);
  for (const r of rows as Record<string, unknown>[]) {
    const serial = String(r.serial ?? "").trim();
    if (!serial) continue;
    const str = (v: unknown) => {
      const s = v == null ? "" : String(v).trim();
      return s === "" ? null : s;
    };
    out.set(serial, {
      serial,
      product: str(r.product),
      sku: str(r.sku),
      lastCustomer: str(r.last_customer),
      lastSo: str(r.last_so),
      lastDirection: str(r.last_direction),
      // Odoo returns a timestamp even for a date cast; keep the date half only.
      lastMovedAt: str(r.last_moved_at)?.slice(0, 10) ?? null,
    });
  }
  return out;
}

/* ── The DT task behind THIS movement (migrations 0039, 0040) ──────────── */

// Ticket and job type exist only in the Delivery Tracker — Odoo's "reference"
// is its own transfer number, not a ticket — and DT's customer is the person
// the task was for, where Odoo's partner is often a vendor. So this is the
// second half of the lookup, and it reads a different system.
//
// THE MISTAKE THE FIRST VERSION MADE, found on the first trip anybody opened.
// It attached each unit's MOST RECENT task, however old. FUL5ZA24120009 was
// scanned inward at Delhi on 11 Sep 2026 and the screen said "Pickup and
// Refund, CHARUVI AGARWAL, ticket 1099165" — a pickup from 8 March, two
// movements ago (the unit left Gurgaon on an internal transfer on 22 March,
// which has no DT task at all). Unlabelled, six-month-old context in a row for
// today's trip reads as a fact about today.
//
// So a task counts as THIS movement only when it is scheduled within
// TASK_WINDOW of the scan, preferring the kind that matches the gate direction
// (a delivery goes OUT, a pickup comes IN), then the nearest date. With no such
// task the unit's latest one is shown instead, labelled as last known with its
// date — see chooseTask.
//
// Still closer to the plan than the Odoo half, and still acceptable only
// because of where the answer goes — gate_scans.task_*, which a manager reads
// and neither the guard's phone nor the reconciliation ever does.

/**
 * How far a task's scheduled date may sit from the scan, in IST calendar days.
 *
 * DT's scheduledDate is a DATE, not a clock (6,659 of 6,753 pinned at 10:00
 * IST), so this is day arithmetic. A delivery truck can load the evening
 * before its scheduled day, hence one day AFTER the scan. A pickup comes back
 * the same evening or a day or two later, hence three days BEFORE. Chosen from
 * how the trucks run, not measured — every gate scan so far is desk test data.
 * Re-measure against Delhi's first real week before trusting the edges.
 */
export const TASK_WINDOW = { daysBeforeScan: 3, daysAfterScan: 1 };

export interface UnitTask {
  serial: string;
  /** "pickup" when the item record hangs off pickup_deliveryId, else "delivery". */
  kind: "pickup" | "delivery";
  /** IST calendar date the task was scheduled for. */
  date: string | null;
  ticket: string | null;
  jobType: string | null;
  customer: string | null;
  so: string | null;
  city: string | null;
}

/**
 * Every task a batch of serials has ever had — a unit's whole life is a
 * handful of records, so no date filter is needed in the query, and matching
 * each scan to its own date is done in TypeScript where it can be tested.
 *
 * $convert rather than $toObjectId: a malformed id must cost that one row its
 * ticket, not throw and cost the whole batch.
 */
export function unitTaskPipeline(serials: string[]): unknown[] | null {
  const safe = askable(serials);
  if (safe.length === 0) return null;
  return [
    { $match: { barcode: { $in: safe } } },
    {
      $lookup: {
        from: "deliveries",
        let: { d: { $convert: {
          input: { $ifNull: ["$pickup_deliveryId", "$deliveryId"] },
          to: "objectId", onError: null, onNull: null,
        } } },
        pipeline: [
          { $match: { $expr: { $eq: ["$_id", "$$d"] } } },
          { $project: { ticketNumber: 1, jobType: 1, firstName: 1, lastName: 1, city: 1, scheduledDate: 1 } },
        ],
        as: "dv",
      },
    },
    { $unwind: { path: "$dv", preserveNullAndEmptyArrays: false } },
    {
      $project: {
        _id: 0, serial: "$barcode", so: "$Sale_Order",
        kind: { $cond: [{ $gt: [{ $ifNull: ["$pickup_deliveryId", null] }, null] }, "pickup", "delivery"] },
        scheduled: "$dv.scheduledDate",
        ticket: "$dv.ticketNumber", jobType: "$dv.jobType", city: "$dv.city",
        customer: { $trim: { input: { $concat: [
          { $ifNull: ["$dv.firstName", ""] }, " ", { $ifNull: ["$dv.lastName", ""] },
        ] } } },
      },
    },
    { $limit: 5000 },
  ];
}

/** Every task per serial. Same contract as fetchUnitFacts: never throws for data. */
export async function fetchUnitTasks(serials: string[]): Promise<Map<string, UnitTask[]>> {
  const out = new Map<string, UnitTask[]>();
  const pipeline = unitTaskPipeline(serials);
  if (!pipeline) return out;

  const { rows } = await runMongoPipeline(dtDatabaseId(), "orderfromcityfurnishes", pipeline, TIMEOUT_MS);
  const str = (v: unknown) => {
    const s = v == null ? "" : String(v).replace(/\s+/g, " ").trim();
    return s === "" || s.toLowerCase() === "null" ? null : s;
  };
  for (const r of rows as Record<string, unknown>[]) {
    const serial = str(r.serial);
    if (!serial) continue;
    const list = out.get(serial) ?? [];
    list.push({
      serial,
      kind: r.kind === "pickup" ? "pickup" : "delivery",
      date: utcToIstDate(str(r.scheduled)) ?? null,
      ticket: str(r.ticket), jobType: str(r.jobType),
      customer: str(r.customer), so: str(r.so), city: str(r.city),
    });
    out.set(serial, list);
  }
  return out;
}

const dayDiff = (a: string, b: string) =>
  Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

/**
 * The task that is this movement, or null.
 *
 * Inside the window only. Within it, the kind matching the direction wins
 * (OUT ↔ delivery, IN ↔ pickup) — but a mismatched kind is still accepted,
 * because a failed delivery coming back IN the same day is a delivery task and
 * is exactly the row a manager wants explained. Then the nearest date.
 */
export function taskForScan(tasks: UnitTask[], scannedAt: string, direction: string | null): UnitTask | null {
  const scanDay = utcToIstDate(scannedAt);
  if (!scanDay) return null;
  const wanted = direction === "OUT" ? "delivery" : direction === "IN" ? "pickup" : null;
  const inWindow = tasks.filter((t) => {
    if (!t.date) return false;
    const d = dayDiff(t.date, scanDay);
    return d >= -TASK_WINDOW.daysBeforeScan && d <= TASK_WINDOW.daysAfterScan;
  });
  inWindow.sort((a, b) =>
    (Number(b.kind === wanted) - Number(a.kind === wanted))
    || (Math.abs(dayDiff(a.date!, scanDay)) - Math.abs(dayDiff(b.date!, scanDay))));
  return inWindow[0] ?? null;
}

/**
 * Whether it is still worth asking about a scan that matched nothing. A task
 * can be entered in DT after the truck has already come through — an ad-hoc
 * pickup logged that evening — so an unmatched scan is re-asked until the
 * window has closed, and only then recorded as "DT has nothing for this".
 */
export function taskWindowClosed(scannedAt: string, now: Date = new Date()): boolean {
  const scanDay = utcToIstDate(scannedAt);
  const today = utcToIstDate(now);
  if (!scanDay || !today) return true;
  return dayDiff(today, scanDay) > TASK_WINDOW.daysAfterScan + 1;
}

/** The unit's newest task by scheduled date, whatever its age. */
export function latestTask(tasks: UnitTask[]): UnitTask | null {
  return [...tasks].filter((t) => t.date).sort((a, b) => b.date!.localeCompare(a.date!))[0] ?? null;
}

/**
 * What to attach to a scan, and whether that answer is final.
 *
 * A task matching this movement wins. Without one, the unit's LATEST task is
 * shown instead — a business decision (11 Sep 2026): a manager chasing a unit
 * is better served by "last seen with this customer on this ticket" than by a
 * blank. It is recorded as matched = false with its own date, and the screen
 * says "last known · <date>", because an unlabelled March pickup in a row for
 * a September trip is exactly what was reported as wrong.
 *
 * Final only once matched, or once the window has closed: until then a task
 * for this movement may still be entered, and would replace the last-known one.
 */
export function chooseTask(tasks: UnitTask[], scannedAt: string, direction: string | null, now: Date = new Date()):
  { task: UnitTask | null; matched: boolean; final: boolean } {
  const match = taskForScan(tasks, scannedAt, direction);
  if (match) return { task: match, matched: true, final: true };
  return { task: latestTask(tasks), matched: false, final: taskWindowClosed(scannedAt, now) };
}
