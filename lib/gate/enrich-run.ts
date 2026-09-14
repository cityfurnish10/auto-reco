// Writing looked-up unit details onto gate scans.
//
// Shared by the scheduled job and by a manager opening a trip. The job runs
// every two hours, so a trip closed at 15:20 showed bare barcodes until 17:00 —
// on exactly the screen a manager opens right after a truck leaves. Opening the
// trip now asks for its own rows straight away; the job still sweeps up
// everything nobody opened.

import type { SupabaseClient } from "@supabase/supabase-js";
import { chooseTask, fetchOrderTasks, fetchSoCustomers, fetchUnitFacts, fetchUnitMoves, fetchUnitTasks, taskForScan, taskWindowClosed, type UnitTask } from "./enrich";
import { resolveMovement, type ResolvedMovement } from "./movement";

export interface ScanToEnrich {
  id: string;
  barcode: string | null;
  /** When and which way it crossed — a DT task is matched to THIS movement. */
  scannedAt: string;
  direction: string | null;
  /** Odoo pass (0037) not yet run. */
  needsFacts: boolean;
  /** DT pass (0039) not yet answered — no match yet, and the window still open. */
  needsTask: boolean;
}

export interface EnrichOutcome {
  considered: number;
  odooMatched: number;
  dtMatched: number;
  /** A half that failed outright. The other half still ran. */
  failed: string[];
}

/**
 * Both lookups, each on its own. A Metabase stall on one system costs that
 * system's columns and nothing else — Odoo being slow must not stop a ticket
 * number from DT arriving, and neither may fail the caller.
 *
 * The "checked" stamp is written on a miss too, so a serial nobody knows is not
 * re-asked every run — for DT, only once the scan's matching window has
 * closed. It is never written when the lookup itself failed: that is not an
 * answer, and the row should be tried again.
 */
export async function enrichScans(db: SupabaseClient, scans: ScanToEnrich[]): Promise<EnrichOutcome> {
  const out: EnrichOutcome = { considered: scans.length, odooMatched: 0, dtMatched: 0, failed: [] };
  const withBarcode = scans.filter((s) => s.barcode && s.barcode.trim());
  if (withBarcode.length === 0) return out;

  const now = new Date().toISOString();
  const factsFor = withBarcode.filter((s) => s.needsFacts);
  const tasksFor = withBarcode.filter((s) => s.needsTask);

  // Odoo first (see movement.ts): the order this movement belongs to, from the
  // In Transit line for outward and the last delivery for inward. DT by
  // barcode is kept as the fallback for the few Odoo cannot place.
  const [facts, moves, tasks] = await Promise.all([
    factsFor.length
      ? fetchUnitFacts(factsFor.map((s) => s.barcode!)).catch((e) => { out.failed.push(`odoo: ${String(e).slice(0, 120)}`); return null; })
      : Promise.resolve(null),
    tasksFor.length
      ? fetchUnitMoves(tasksFor.map((s) => s.barcode!)).catch((e) => { out.failed.push(`odoo moves: ${String(e).slice(0, 120)}`); return null; })
      : Promise.resolve(null),
    tasksFor.length
      ? fetchUnitTasks(tasksFor.map((s) => s.barcode!)).catch((e) => { out.failed.push(`dt: ${String(e).slice(0, 120)}`); return null; })
      : Promise.resolve(null),
  ]);

  // DT tasks for every order involved, one query, in a window around the batch.
  let orderTasks: Awaited<ReturnType<typeof fetchOrderTasks>> | null = [];
  if (moves && tasksFor.length) {
    const sos = new Set<string>(), refs = new Set<string>();
    for (const s of tasksFor) for (const m of moves.get(s.barcode!.trim()) ?? []) { sos.add(m.so); if (m.orderRef) refs.add(m.orderRef); }
    const times = tasksFor.map((s) => Date.parse(s.scannedAt)).filter((t) => !Number.isNaN(t));
    if (sos.size && times.length) {
      const DAY = 86_400_000;
      orderTasks = await fetchOrderTasks([...sos], [...refs], new Date(Math.min(...times) - 6 * DAY), new Date(Math.max(...times) + 6 * DAY))
        .catch((e) => { out.failed.push(`dt orders: ${String(e).slice(0, 120)}`); return null; });
    }
  }

  const resolved = new Map<string, ResolvedMovement | null>();
  const chosen = new Map<string, ReturnType<typeof chooseTask>>();
  for (const s of tasksFor) {
    const key = s.barcode!.trim();
    const link = tasks ? taskForScan(tasks.get(key) ?? [], s.scannedAt, s.direction) : null;
    const r = moves ? resolveMovement(moves.get(key) ?? [], orderTasks ?? [], s.scannedAt, s.direction, link) : null;
    resolved.set(s.id, r);
    if (!r && tasks) chosen.set(s.id, chooseTask(tasks.get(key) ?? [], s.scannedAt, s.direction));
  }
  // Customers for the fallback path only; the Odoo path already carries its own.
  const orders = [...new Set([...chosen.values()].map((c) => c.task?.so).filter((o): o is string => !!o))];
  let customers: Map<string, string> | null = new Map();
  if (orders.length) {
    customers = await fetchSoCustomers(orders)
      .catch((e) => { out.failed.push(`odoo customers: ${String(e).slice(0, 120)}`); return null; });
  }
  // No Odoo customer → blank, never DT's name as a stand-in.
  const customerFor = (t: UnitTask) => (t.so && customers?.get(t.so)) || null;

  for (const s of withBarcode) {
    const key = s.barcode!.trim();
    const patch: Record<string, unknown> = {};
    if (s.needsFacts && facts) {
      const f = facts.get(key);
      if (f) {
        Object.assign(patch, {
          unit_product: f.product, unit_sku: f.sku,
          last_customer: f.lastCustomer, last_so: f.lastSo,
          last_direction: f.lastDirection, last_moved_at: f.lastMovedAt,
        });
        out.odooMatched++;
      }
      patch.enriched_at = now;
    }
    if (s.needsTask && moves && orderTasks) {
      const r = resolved.get(s.id);
      if (r) {
        Object.assign(patch, {
          task_ticket: r.ticket, task_job_type: r.jobType, task_customer: r.customer,
          task_so: r.so, task_city: r.city, task_date: r.date, task_matched: true,
        });
        out.dtMatched++;
        // Final once DT's ticket is in, or the window for one has passed. Until
        // then the SO and customer show, and the row is asked again.
        if (r.ticket || taskWindowClosed(s.scannedAt)) patch.task_checked_at = now;
      } else if (tasks && customers) {
        const { task: t, matched, final } = chosen.get(s.id)!;
        if (t) {
          Object.assign(patch, {
            task_ticket: t.ticket, task_job_type: t.jobType, task_customer: customerFor(t),
            task_so: t.so, task_city: t.city, task_date: t.date, task_matched: matched,
          });
          if (matched) out.dtMatched++;
        }
        // Not final while a record for this movement could still appear in
        // Odoo or DT — Odoo in particular is posted after goods arrive.
        if (final) patch.task_checked_at = now;
      }
    }
    if (Object.keys(patch).length === 0) continue;
    // One row failing must not abandon the rest; it is picked up next run.
    const up = await db.from("gate_scans").update(patch).eq("id", s.id);
    // task_date / task_matched arrive with 0040, applied by hand. Until then,
    // write the rest rather than losing the whole row's answer.
    if (isMissingColumn(up.error) && "task_date" in patch) {
      // Without 0040 there is no way to label a last-known task as such, and an
      // unlabelled one is the reported bug. Keep only a genuine match.
      delete patch.task_date;
      if (patch.task_matched === false) {
        for (const k of ["task_ticket", "task_job_type", "task_customer", "task_so", "task_city"]) delete patch[k];
      }
      delete patch.task_matched;
      if (Object.keys(patch).length) await db.from("gate_scans").update(patch).eq("id", s.id);
    }
  }
  return out;
}

/** Postgres "undefined column": migration 0039 not applied yet. */
export const isMissingColumn = (e: { code?: string } | null | undefined) => e?.code === "42703";
