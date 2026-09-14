// Which order a gate movement belongs to — decided from Odoo first.
//
// WHY ODOO AND NOT DT. Tested against Delhi's first live days (13–14 Sep 2026):
//
//   OUTWARD. Per warehouse SOP an item is marked IN TRANSIT in Odoo against its
//   customer's sale order before it is loaded. 77 of 88 outward scans on 14 Sep
//   had that line, 75 posted before the truck reached the gate (up to 73 minutes
//   before). The other 11 each had a reserved OUT line with its SO, created that
//   morning. Together: 186 of 189 outward scans resolve to an SO and customer.
//
//   DT cannot do this. It ties a barcode to a delivery only when the agent
//   handles the item at the doorstep — today's links were created 12:30–13:36,
//   after the trucks left at 09:32–11:55 — so a DT-first lookup at the gate
//   either found nothing or found the pickup that brought the unit back: the
//   PREVIOUS customer.
//
//   INWARD. A pickup, repair or replacement brings back a unit that is already
//   out with a customer, so the order it belongs to is the last delivery Odoo
//   sent it on. 26 of 26 inward scans resolve that way.
//
// DT then supplies what only DT holds — the ticket and job type — found by the
// SO, or by the Odoo order reference (sale_order.reference_no), which is DT's
// orderId. The reference matters: one customer order is split into several SOs
// in Odoo and DT records one of them (ON-RET-GUR-81138…81144 share a
// reference). By SO alone 107 of 189 outward scans got a ticket; with the
// reference, 182.
//
// Pure functions. The queries live in enrich.ts; the decision lives here so it
// can be tested against the real cases that shaped it.

export interface OdooMove {
  serial: string;
  /** Posting time. Not movement time for receipts, but for In Transit it is
   *  set as the item is prepared, which is what the gate needs. */
  date: string;
  state: string;
  /** "In" | "Out" | "In Transit" */
  movementType: string;
  so: string;
  /** sale_order.reference_no — DT's orderId. */
  orderRef: string | null;
  /** sale_order.partner_id — the customer Odoo holds, which the business treats
   *  as correct over DT's contact name. */
  customer: string | null;
}

export interface DtOrderTask {
  ticket: string;
  jobType: string | null;
  city: string | null;
  /** IST calendar date scheduled. */
  date: string | null;
  sos: string[];
  orderRefs: string[];
}

export interface ResolvedMovement {
  so: string;
  customer: string | null;
  ticket: string | null;
  jobType: string | null;
  city: string | null;
  date: string | null;
  /** How the order was found — for the reader, and for whoever debugs this. */
  via: "in_transit" | "reserved_out" | "last_delivery";
}

const H = 3600_000;
/** An outward item is marked In Transit shortly before loading; the latest seen
 *  was 150 minutes before its gate scan, and one posted 22.5 hours after. */
export const OUT_MOVE_WINDOW_MS = 36 * H;
/**
 * A ticket is accepted from this many days before the scan to this many after.
 * Asymmetric for the reason DT's own window is: a truck loads the evening
 * before a delivery day, and a pickup reaches the gate days after it was
 * scheduled. A symmetric ±5 days picked an installation scheduled 16 Sep for a
 * unit that left on 13 Sep — 4 of the 6 disagreements with DT's own links.
 */
export const TICKET_WINDOW = { daysBeforeScan: 3, daysAfterScan: 1 };

const PICKUP_JOBS = /pickup|repair|return|refund/i;
const DELIVERY_JOBS = /new|rental|delivery|installation|b2b|upgrade|relocation|replace/i;

/** The Odoo line that IS this movement, or null. */
export function odooMoveForScan(moves: OdooMove[], scannedAt: string, direction: string | null): OdooMove | null {
  const at = Date.parse(scannedAt);
  if (Number.isNaN(at)) return null;
  const live = moves.filter((m) => m.so && m.state !== "cancel");
  if (direction === "OUT") {
    const near = live.filter((m) => (m.movementType === "In Transit" || m.movementType === "Out")
      && Math.abs(Date.parse(m.date) - at) <= OUT_MOVE_WINDOW_MS);
    // In Transit first: it is the SOP step taken for THIS dispatch. A reserved
    // Out line is the fallback the 11 without one were found on.
    near.sort((a, b) =>
      Number(b.movementType === "In Transit") - Number(a.movementType === "In Transit")
      || Math.abs(Date.parse(a.date) - at) - Math.abs(Date.parse(b.date) - at));
    return near[0] ?? null;
  }
  if (direction === "IN") {
    // The delivery that put it with the customer it is coming back from.
    const out = live.filter((m) => m.movementType === "Out" && m.state === "done" && Date.parse(m.date) <= at)
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    return out[0] ?? null;
  }
  return null;
}

const dayDiff = (a: string, b: string) =>
  Math.round((Date.parse(`${a.slice(0, 10)}T00:00:00Z`) - Date.parse(`${b.slice(0, 10)}T00:00:00Z`)) / 86_400_000);

const istDay = (iso: string) => new Date(Date.parse(iso) + 5.5 * H).toISOString().slice(0, 10);

/**
 * The DT task for an order near the scan. When several fit — 20 of 189 outward
 * scans had more than one — the one whose job type fits the direction wins,
 * then the nearest date. On an INWARD scan the order is the old delivery's, so
 * the task wanted is the pickup/repair raised against it NOW, near the scan.
 */
export function ticketForOrder(tasks: DtOrderTask[], move: OdooMove, scannedAt: string, direction: string | null): DtOrderTask | null {
  const scanDay = istDay(scannedAt);
  const fits = direction === "OUT" ? DELIVERY_JOBS : PICKUP_JOBS;
  const cands = tasks.filter((t) =>
    (t.sos.includes(move.so) || (!!move.orderRef && t.orderRefs.includes(move.orderRef)))
    && !!t.date
    && dayDiff(t.date, scanDay) >= -TICKET_WINDOW.daysBeforeScan
    && dayDiff(t.date, scanDay) <= TICKET_WINDOW.daysAfterScan);
  cands.sort((a, b) =>
    Number(fits.test(b.jobType ?? "")) - Number(fits.test(a.jobType ?? ""))
    || Math.abs(dayDiff(a.date!, scanDay)) - Math.abs(dayDiff(b.date!, scanDay))
    || Number(b.sos.includes(move.so)) - Number(a.sos.includes(move.so)));
  return cands[0] ?? null;
}

/** DT's own link of this barcode to a task, made at the doorstep, when present. */
export interface DtUnitLink { ticket: string | null; jobType: string | null; city: string | null; date: string | null }

/**
 * The order from Odoo; the ticket from DT.
 *
 * Once DT has linked this very barcode to a task of the right kind near the scan
 * (the agent handled it), that ticket wins over one inferred from the order: it
 * is DT saying which job this unit was, rather than which jobs its order has.
 * Before that link exists — every outward item while its truck is still out —
 * the order's task stands.
 */
export function resolveMovement(moves: OdooMove[], tasks: DtOrderTask[], scannedAt: string, direction: string | null,
                                dtLink: DtUnitLink | null = null): ResolvedMovement | null {
  const move = odooMoveForScan(moves, scannedAt, direction);
  if (!move) return null;
  const inferred = ticketForOrder(tasks, move, scannedAt, direction);
  const task = dtLink?.ticket ? dtLink : inferred;
  return {
    so: move.so,
    customer: move.customer,
    ticket: task?.ticket ?? null,
    jobType: task?.jobType ?? null,
    city: task?.city ?? null,
    date: task?.date ?? move.date.slice(0, 10),
    via: direction === "IN" ? "last_delivery" : move.movementType === "In Transit" ? "in_transit" : "reserved_out",
  };
}
