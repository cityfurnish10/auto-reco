// Section 4 — Odoo Date Window. Filters raw Odoo rows by POSTING date
// (createdOn = the IST calendar date the stock move was validated in Odoo;
// fallback movementDate) against the derived run date.
//
// Rewritten 2026-07-15 against live data. The original per-city rules (GUR
// next-day-only, BAN/MUM same-day, …) were derived from manual exports keyed
// on Odoo's create_date — which turned out to be ORDER-creation time (often
// weeks before the movement), not posting time. Measured on real 2026-07-12
// data (607 DT movements): 237 were posted in Odoo same-day, 302 next-day,
// 0 the day before — uniformly across cities. So the window is now a uniform
// [run-1 .. run+1] on posting date: next-day postings are legitimate matches
// for the run's movements; the day-before margin is cheap insurance (the doc
// claimed HYD posts ±1). Attribution safety: an Odoo row from an adjacent
// day can MATCH (suppress a false "Not in Odoo") but can never itself surface
// as an "Odoo-Only" variance — the ladder's rung 9 requires a same-day
// posting (BarcodeView.odooSameDay), so each posting is judged exactly once,
// in its own day's run.
//
// If the filter would empty an otherwise non-empty export, fall back to all
// rows and record a warning (never silently emit a zero Odoo count).

import type { City } from "../sample-data";
import { addDays, parseDate } from "./dates";
import type { CityCode, SourceRow } from "./types";

export function cityToCode(city: City): CityCode {
  switch (city) {
    case "DELHI":
      return "GUR"; // Gurgaon / Delhi-NCR
    case "PUNE":
      return "PUN";
    case "BANGALORE":
      return "BAN";
    case "MUMBAI":
      return "MUM";
    case "HYDERABAD":
      return "HYD";
  }
}

function odooRowDate(row: SourceRow): string | null {
  return parseDate(row.createdOn) ?? parseDate(row.movementDate);
}

export function filterOdooWindow(
  odooRows: SourceRow[],
  city: City,
  runDate: string,
  warnings: string[]
): SourceRow[] {
  if (odooRows.length === 0) return odooRows;

  const prev = addDays(runDate, -1);
  const next = addDays(runDate, 1);
  const filtered = odooRows.filter((row) => {
    const rowDate = odooRowDate(row);
    if (!rowDate) return false;
    return rowDate === runDate || rowDate === next || rowDate === prev;
  });

  if (filtered.length === 0) {
    warnings.push(
      `Odoo window (${cityToCode(city)}) emptied a non-empty export for ${city} on ${runDate}; falling back to all ${odooRows.length} rows (possible date-parse mismatch).`
    );
    return odooRows;
  }
  return filtered;
}
