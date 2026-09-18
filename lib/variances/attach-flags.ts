// Server side of lib/variances/flags.ts: gathers what the pure rule needs for
// a page of variance rows, in a handful of queries per (city, day).
//
// Uses the admin client for the lookups, deliberately and narrowly: the rows
// themselves were already read through RLS by the caller, and all this returns
// about each one is a yes/no computed from its own city and day — nothing from
// another city reaches the response. Shifts and source rows are not all
// readable by a manager's RLS role, and the flags must not differ by who looks.
//
// A failed lookup leaves the rows unflagged rather than failing the list: a
// flag is a hint, and the list is the job.

import { createAdminClient } from "@/lib/supabase/admin";
import type { ClosureCalendar } from "@/lib/engine/schedule";
import { gateAppCities } from "@/lib/connectors/guard";
import { normalizeStatus } from "@/lib/engine/util";
import type { City } from "@/lib/sample-data";
import { flagsFor, odooWindowEnd, type VarianceFlag } from "./flags";

interface Row {
  run_id: string;
  business_date: string;
  city: string;
  barcode: string;
  direction: string;
  job_type: string | null;
  present_p?: boolean;
  present_d?: boolean;
  present_o?: boolean;
}

export async function attachFlags<T extends Row>(rows: T[]): Promise<(T & { flags: VarianceFlag[] })[]> {
  if (!rows.length) return [];
  const none = () => rows.map((r) => ({ ...r, flags: [] as VarianceFlag[] }));
  try {
    const db = createAdminClient();
    const nowMs = Date.now();

    // Closure calendar — once.
    let cal: ClosureCalendar | null = null;
    const calRes = await db.from("warehouse_calendar").select("city, weekday, holiday_date");
    if (!calRes.error && calRes.data?.length) {
      const weeklyOff: Record<string, number[]> = {};
      const holidays: Record<string, string[]> = {};
      for (const r of calRes.data as { city: string; weekday: number | null; holiday_date: string | null }[]) {
        if (r.weekday !== null && r.weekday !== undefined) (weeklyOff[r.city] ??= []).push(r.weekday);
        else if (r.holiday_date) (holidays[r.city] ??= []).push(r.holiday_date);
      }
      cal = { weeklyOff, holidays } as ClosureCalendar;
    }

    const groups = new Map<string, T[]>();
    for (const r of rows) {
      const k = `${r.city}|${r.business_date}|${r.run_id}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }

    const guardOnDuty = new Map<string, boolean | null>(); // city|day
    const notDelivered = new Set<string>(); // run|city|barcode (outward)

    await Promise.all([...groups.entries()].map(async ([k, list]) => {
      const [city, day, runId] = k.split("|");

      // Rule A: was ANY guard signed in at this gate at any point in the day?
      const gk = `${city}|${day}`;
      if (!guardOnDuty.has(gk)) {
        guardOnDuty.set(gk, null);
        if (gateAppCities(day).has(city as City)) {
          const start = new Date(`${day}T00:00:00+05:30`).toISOString();
          const end = new Date(Date.parse(`${day}T00:00:00+05:30`) + 86_400_000).toISOString();
          // A shift touches the day if it began before the day ended and had
          // not ended before the day began (or is still open).
          const s = await db.from("guard_shifts").select("id", { count: "exact", head: true })
            .eq("city", city).lt("checked_in_at", end)
            .or(`checked_out_at.is.null,checked_out_at.gte.${start}`);
          if (!s.error) guardOnDuty.set(gk, (s.count ?? 0) > 0);
        }
      }

      // NOT DELIVERED: the run's own sheet and tracker rows for these barcodes.
      const outs = [...new Set(list.filter((r) => r.direction === "OUT").map((r) => r.barcode))];
      for (let i = 0; i < outs.length; i += 200) {
        const sr = await db.from("source_rows")
          .select("source, status, barcode_canonical, raw")
          .eq("run_id", runId).eq("city", city).eq("direction", "OUT")
          .in("source", ["SHEET", "DT"])
          .in("barcode_canonical", outs.slice(i, i + 200));
        if (sr.error) continue;
        for (const x of (sr.data ?? []) as { source: string; status: string | null; barcode_canonical: string; raw: { physicalStatus?: string } | null }[]) {
          const nd = x.source === "SHEET"
            ? normalizeStatus(x.status) === "not_done"
            : /^not\s*done$/i.test(x.raw?.physicalStatus ?? "");
          if (nd) notDelivered.add(`${runId}|${city}|${x.barcode_canonical}`);
        }
      }
    }));

    return rows.map((r) => ({
      ...r,
      flags: flagsFor(r, {
        odooWindowEndMs: odooWindowEnd(r.city, r.business_date, cal),
        nowMs,
        guardOnDuty: guardOnDuty.get(`${r.city}|${r.business_date}`) ?? null,
        notDelivered: notDelivered.has(`${r.run_id}|${r.city}|${r.barcode}`),
      }),
    }));
  } catch {
    return none();
  }
}
