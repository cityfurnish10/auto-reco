// Guard connector — the PHYSICAL source.
//
// Reads from ONE OF TWO PLACES depending on the city:
//
//   gate_scans      the digital gate register (0023). Exact, typed, complete.
//   guard_uploads   the OCR'd paper register. What every city used until now.
//
// The switch is per city and lives in GATE_APP_CITIES below. Per city rather
// than global because the rollout is a pilot: Delhi moves while the other four
// stay on paper, and a bad week in Delhi is reverted by editing one list — no
// deploy of the engine, no migration, no data to unpick.
//
// Both paths return the SAME SourceRow shape, which is the entire reason this
// swap is safe: the ladder, the 23 variance names, the buckets, the digest and
// the dashboards never learn where a row came from.

import { createAdminClient } from "../supabase/admin";
import type { Connector, CityTaggedRow } from "./types";
import type { GuardUpload } from "../db/schema";
import { CITIES, type City } from "../sample-data";

/**
 * Cities whose gate record now comes from the app.
 *
 * Driven by GATE_APP_CITIES (comma-separated) so the pilot can be widened or
 * pulled back without a code change. Empty means every city still reads the
 * paper register, which is the state on the day this ships.
 *
 * A city listed here does NOT fall back to OCR if the app returns nothing —
 * that would be the worst of both worlds. A gate with no scans is a gate that
 * reported nothing, and the reported-aware ladder already knows what to do with
 * an absent source: treat it as down, not as a confident zero.
 */
export function gateAppCities(): Set<City> {
  const raw = process.env.GATE_APP_CITIES ?? "";
  const wanted = raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  return new Set(wanted.filter((c): c is City => (CITIES as readonly string[]).includes(c)));
}

export const guardConnector: Connector = {
  source: "PHYSICAL",
  label: "Gate Register",
  async pull(runDate: string, ctx): Promise<CityTaggedRow[]> {
    const db = createAdminClient();
    const appCities = gateAppCities();
    const rows: CityTaggedRow[] = [];

    // ── Cities on the app ────────────────────────────────────────────────
    if (appCities.size > 0) {
      const { data, error } = await db
        .from("gate_scans")
        .select("city,direction,barcode,serial_no,item_kind,quantity,so_number,ticket_id,product,customer,entry_method,scanned_at")
        .eq("business_date", runDate)
        .eq("status", "recorded")
        .in("city", [...appCities]);

      if (error) throw new Error(`Gate connector (scans) failed: ${error.message}`);

      for (const r of (data ?? []) as Record<string, unknown>[]) {
        const barcode = String(r.barcode ?? "").trim();
        // Counted extras — spares, consumables, packing boxes, samples — carry
        // no serial by design. The engine's count layer handles those from the
        // other sources and a barcode-less row cannot enter the per-barcode
        // ladder, so they are not emitted here.
        if (!barcode) continue;
        rows.push({
          source: "PHYSICAL",
          city: r.city as City,
          direction: r.direction as "IN" | "OUT",
          // The RAW spelling, exactly as the QR gave it. This is what finally
          // gives a gate row a true barcode to display — the fold is applied
          // downstream for matching only.
          barcode,
          status: "done",
          date: runDate,
          soNumber: (r.so_number as string) || undefined,
          ticketId: (r.ticket_id as string) || undefined,
          product: (r.product as string) || undefined,
          customer: (r.customer as string) || undefined,
        });
      }

      // A city on the app that produced nothing is a gate that did not report —
      // an unmanned shift, a phone that never synced. Saying so demotes the
      // source for that city instead of letting silence read as "nothing moved",
      // which is what turns an outage into a flood of false absences.
      for (const c of appCities) {
        if (!rows.some((r) => r.city === c)) {
          ctx?.warn(`${c}: no gate scans for ${runDate}`);
          ctx?.incomplete(c);
        }
      }
    }

    // ── Cities still on paper ────────────────────────────────────────────
    const paperCities = CITIES.filter((c) => !appCities.has(c));
    if (paperCities.length > 0) {
      const { data, error } = await db
        .from("guard_uploads")
        .select("*")
        .eq("business_date", runDate)
        .eq("status", "processed")
        .in("city", paperCities);

      if (error) throw new Error(`Gate connector (uploads) failed: ${error.message}`);

      for (const upload of (data ?? []) as GuardUpload[]) {
        const city = upload.city as City;
        for (const row of upload.parsed_rows ?? []) {
          const barcode = row.cells.barcode?.trim();
          if (!barcode || !row.direction) continue;
          rows.push({
            source: "PHYSICAL",
            city,
            direction: row.direction,
            barcode,
            status: "done",
            date: runDate,
            soNumber: row.cells.so_number || row.cells.po_number || undefined,
            ticketId: row.cells.ticket_id || undefined,
            product: row.cells.product || undefined,
            jobType: row.cells.operation_type || undefined,
          });
        }
      }
    }

    return rows;
  },
};
