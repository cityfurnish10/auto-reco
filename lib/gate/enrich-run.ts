// Writing looked-up unit details onto gate scans.
//
// Shared by the scheduled job and by a manager opening a trip. The job runs
// every two hours, so a trip closed at 15:20 showed bare barcodes until 17:00 —
// on exactly the screen a manager opens right after a truck leaves. Opening the
// trip now asks for its own rows straight away; the job still sweeps up
// everything nobody opened.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchUnitFacts, fetchUnitTasks, taskForScan, taskWindowClosed } from "./enrich";

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

  const [facts, tasks] = await Promise.all([
    factsFor.length
      ? fetchUnitFacts(factsFor.map((s) => s.barcode!)).catch((e) => { out.failed.push(`odoo: ${String(e).slice(0, 120)}`); return null; })
      : Promise.resolve(null),
    tasksFor.length
      ? fetchUnitTasks(tasksFor.map((s) => s.barcode!)).catch((e) => { out.failed.push(`dt: ${String(e).slice(0, 120)}`); return null; })
      : Promise.resolve(null),
  ]);

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
    if (s.needsTask && tasks) {
      const t = taskForScan(tasks.get(key) ?? [], s.scannedAt, s.direction);
      if (t) {
        Object.assign(patch, {
          task_ticket: t.ticket, task_job_type: t.jobType, task_customer: t.customer,
          task_so: t.so, task_city: t.city, task_date: t.date,
        });
        out.dtMatched++;
        patch.task_checked_at = now;
      } else if (taskWindowClosed(s.scannedAt)) {
        // Only now is "DT has no task for this movement" an answer. Before it,
        // the task may simply not have been entered yet.
        patch.task_checked_at = now;
      }
    }
    if (Object.keys(patch).length === 0) continue;
    // One row failing must not abandon the rest; it is picked up next run.
    const up = await db.from("gate_scans").update(patch).eq("id", s.id);
    // task_date arrives with 0040, applied by hand. Until then, write the rest
    // rather than losing the whole row's answer over one column.
    if (isMissingColumn(up.error) && "task_date" in patch) {
      delete patch.task_date;
      await db.from("gate_scans").update(patch).eq("id", s.id);
    }
  }
  return out;
}

/** Postgres "undefined column": migration 0039 not applied yet. */
export const isMissingColumn = (e: { code?: string } | null | undefined) => e?.code === "42703";
