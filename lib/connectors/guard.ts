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
 * Cities whose gate record now comes from the app — optionally FROM A DATE.
 *
 * Driven by GATE_APP_CITIES (comma-separated) so the pilot can be widened or
 * pulled back without a code change. Empty means every city still reads the
 * paper register, which is the state on the day this ships.
 *
 *   "DELHI"              the app for every business date
 *   "DELHI:2026-09-13"   the app from business date 13 Sep 2026; paper before it
 *
 * THE DATE IS NOT DECORATION. The reconcile cron re-checks earlier days and a
 * manager can re-run any date. Without a start, switching a city on would also
 * swap its gate record for every earlier day re-run afterwards — replacing a
 * register that was reconciled with a handful of desk-test scans, and filling
 * those days with false absences. A start date confines the switch to the days
 * the app was really in use.
 *
 * A city listed here does NOT fall back to OCR if the app returns nothing —
 * that would be the worst of both worlds. A gate with no scans is a gate that
 * reported nothing, and the reported-aware ladder already knows what to do with
 * an absent source: treat it as down, not as a confident zero.
 */
export function gateAppCities(runDate?: string): Set<City> {
  const raw = process.env.GATE_APP_CITIES ?? "";
  const out = new Set<City>();
  for (const part of raw.split(",")) {
    const [cityRaw, fromRaw] = part.split(":").map((x) => x.trim());
    const city = (cityRaw ?? "").toUpperCase();
    if (!(CITIES as readonly string[]).includes(city)) continue;
    // A malformed date must not silently switch a city on for all history.
    if (fromRaw !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(fromRaw)) continue;
    if (fromRaw && runDate && runDate < fromRaw) continue;
    out.add(city as City);
  }
  return out;
}

export const guardConnector: Connector = {
  source: "PHYSICAL",
  label: "Gate Register",
  async pull(runDate: string, ctx): Promise<CityTaggedRow[]> {
    const db = createAdminClient();
    const appCities = gateAppCities(runDate);
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
        // A barcode scanned twice the same day in the same direction is passed
        // through as twice, on purpose: the engine counts the unit ONCE (its
        // views are per barcode, per direction) and raises "Duplicate Scan"
        // for it. Dropping the second here would count it once and lose the
        // flag — and the flag is how ops hears a guard double-logged.
        //
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

      // A city on the app that produced nothing is USUALLY a gate that did not
      // report — an unmanned shift, a phone that never synced — and saying so
      // demotes the source rather than letting silence read as "nothing moved",
      // which is what turns an outage into a flood of false absences.
      //
      // But a genuinely quiet gate looks identical, and used to be recorded as
      // a failure. A guard can now assert it, and that assertion is what
      // separates the two.
      //
      // BOTH conditions are required: the flag AND no scans. The flag is
      // already refused at sync time when the guard's own scans contradict it,
      // so this is the second of two independent checks — a confident zero is
      // the one verdict here that can invent stock, and it should take more
      // than one mistake to produce.
      const quietCities = new Set<City>();
      if (appCities.size > 0) {
        const { data: quiet } = await db
          .from("guard_shifts")
          .select("city")
          .eq("business_date", runDate)
          .eq("nothing_moved", true)
          .in("city", [...appCities]);
        for (const q of (quiet ?? []) as { city: string }[]) {
          quietCities.add(q.city as City);
        }
      }

      for (const c of appCities) {
        if (rows.some((r) => r.city === c)) continue;
        if (quietCities.has(c)) {
          // A real zero, asserted by somebody who was there. The source stays
          // trusted, and the ladder reads an empty gate as "nothing moved"
          // rather than "the gate is down".
          ctx?.warn(`${c}: gate reported a quiet day for ${runDate}`);
          continue;
        }
        ctx?.warn(`${c}: no gate scans for ${runDate}`);
        ctx?.incomplete(c);
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
