// Section 4 — Odoo Date Window (per-city rules). Filters raw Odoo rows using
// createdOn (fallback movementDate) against the derived run date. If the
// filter would empty an otherwise non-empty export, fall back to all rows and
// record a warning (never silently emit a zero Odoo count — Section 4/12).

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
    case "HYDRABAD":
      return "HYD";
  }
}

function odooRowDate(row: SourceRow): string | null {
  return parseDate(row.createdOn) ?? parseDate(row.movementDate);
}

function keep(code: CityCode, rowDate: string, runDate: string): boolean {
  const next = addDays(runDate, 1);
  switch (code) {
    case "GUR": // strictly next-day only
      return rowDate === next;
    case "PUN": // same-day plus next-day tail
      return rowDate === runDate || rowDate === next;
    case "BAN": // batch dated run+1 that mixes next day — match created_on == run
      return rowDate === runDate;
    case "MUM": // same batch quirk; guard against created_on > run leaking in
      return rowDate === runDate;
    case "HYD": // default ±1 day window
      return (
        rowDate === runDate ||
        rowDate === next ||
        rowDate === addDays(runDate, -1)
      );
  }
}

export function filterOdooWindow(
  odooRows: SourceRow[],
  city: City,
  runDate: string,
  warnings: string[]
): SourceRow[] {
  if (odooRows.length === 0) return odooRows;

  const code = cityToCode(city);
  const filtered = odooRows.filter((row) => {
    const rowDate = odooRowDate(row);
    if (!rowDate) return false;
    return keep(code, rowDate, runDate);
  });

  if (filtered.length === 0) {
    warnings.push(
      `Odoo window (${code}) emptied a non-empty export for ${city} on ${runDate}; falling back to all ${odooRows.length} rows (possible date-parse mismatch).`
    );
    return odooRows;
  }
  return filtered;
}
