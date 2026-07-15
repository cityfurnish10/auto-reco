// Google Sheets connector mapping helpers — date parsing/resolution.
// Pure functions, unit-testable without a live Sheets API call (per the
// dt-mapping.ts/odoo-mapping.ts convention). Direction is NOT derived here —
// the live sheets encode it by which tab a row is on (Outward/Inward).
//
// Why this is more than a one-liner: the 5 real warehouse sheets are
// internally INCONSISTENT about dates (verified against live data, 2026-07):
//   - DELHI cells store a correct machine serial (46216 = 13 Jul) but DISPLAY
//     in US M/D/Y ("7/13/2026").
//   - HYD/MUM cells DISPLAY the intended day ("12-07-2026" = 12 Jul, India
//     D/M) but their serial is corrupt — the US-locale sheet read the "12-07"
//     entry as MM-DD and stored 7 Dec (serial 46363).
// So neither "always trust the serial" nor "always trust the display" is
// correct. resolveSheetDate() reconciles the two: trust the machine serial
// when it's plausible, and fall back to the day-first display only when the
// serial is clearly corrupt (far from the date being reconciled).

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Sheets serial (whole days since the 1899-12-30 epoch) → "YYYY-MM-DD".
// UTC-based so it never drifts by a day across timezones.
function serialToIso(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000); // 25569 = 1899-12-30 → 1970-01-01
  return new Date(ms).toISOString().slice(0, 10);
}

function ymd(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

const RE_ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})/;
const RE_SEP = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/;

function fullYear(y: number): number {
  return y < 100 ? 2000 + y : y;
}

// Which field comes first in a sheet's displayed dates.
//   "DMY" — day-first, e.g. HYD "13-07-2026" (13 = day, 07 = July)
//   "MDY" — month-first, e.g. DELHI "7/13/2026" (7 = July, 13 = day)
export type DateOrder = "DMY" | "MDY";

// Detect a sheet column's field order from its OWN displayed dates. The signal
// is the unambiguous rows: any date with a field > 12 pins the order (that
// field can only be the day). The latest appended rows — the current month
// (July) — are where this shows up, since real day-of-month values run 13..31
// there. E.g. DELHI's recent "7/13/2026": 13 can't be a month, so 13 is the
// day and the leading 7 is July-the-MONTH (month-first). HYD's "13-07-2026":
// 13 leads, so day-first. Majority vote across the sampled cells; null when
// every sampled date is ambiguous (all fields ≤ 12), in which case callers
// fall back to day-first (the India default).
export function detectDateOrder(displayCells: Iterable<unknown>): DateOrder | null {
  let dmy = 0;
  let mdy = 0;
  for (const cell of displayCells) {
    const m = RE_SEP.exec(String(cell ?? "").trim());
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) dmy++; // first field must be the day → day-first
    else if (b > 12 && a <= 12) mdy++; // second field must be the day → month-first
  }
  if (dmy === 0 && mdy === 0) return null;
  return dmy >= mdy ? "DMY" : "MDY";
}


// Parse a DISPLAYED date string, day-first when ambiguous (India convention).
// Timezone-safe (string arithmetic only — never Date.parse, whose result then
// gets toISOString()'d and silently shifts a day at IST). A field > 12 forces
// the ordering unambiguously; when both are ≤ 12 it defaults day-first.
export function parseDisplayDate(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();

  const iso = RE_ISO.exec(s);
  if (iso) return ymd(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const m = RE_SEP.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = fullYear(Number(m[3]));
    if (a > 12 && b <= 12) return ymd(year, b, a); // a must be the day
    if (b > 12 && a <= 12) return ymd(year, a, b); // b must be the day → a is month
    return ymd(year, b, a); // ambiguous → day-first (a=day, b=month)
  }
  return null;
}

// Back-compat parser: a serial number, or a text date read day-first.
// (Serial path is now timezone-safe; the old Date.parse fallback that could
// shift a day is gone.)
export function parseSheetDate(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") return serialToIso(raw);
  return parseDisplayDate(raw);
}

// The one function the connector calls per row. `serialCell` is the raw
// UNFORMATTED value (a number for real date cells, a string for text-typed
// ones); `displayCell` is the FORMATTED value (what the operator sees/typed);
// `order` is the sheet's own detected field order (fallback); `runDate` is the
// IST business day being reconciled.
//
// Resolution priority for the displayed date string:
//   1. ISO (yyyy-mm-dd) — unambiguous.
//   2. A field > 12 must be the day — pins the order regardless of anything.
//   3. RUN-MONTH ANCHOR ("7 = July"): the latest appended rows are the current
//      operational month, so for an ambiguous date (both fields ≤ 12) the field
//      that equals the run's month IS the month and the other is the day. This
//      is the ONLY thing that recovers a locale mis-entry the sheet itself
//      stored wrong — MUMBAI writes month-first and the operator typed "12/7"
//      meaning 12 July, which the sheet saved/renders as 7 Dec; anchoring on
//      the run month (7 = July) recovers 12 July. (Sound because the pipeline
//      is strictly D-1 — there is no future-month data to alias onto today.)
//   4. Otherwise fall back to the sheet's detected field order (day-first when
//      none was detected — the India default).
//   5. No parseable display → the raw serial.
export function resolveSheetDate(
  serialCell: unknown,
  displayCell: unknown,
  order: DateOrder | null,
  runDate: string
): string | null {
  const s = String(displayCell ?? "").trim();

  const iso = RE_ISO.exec(s);
  if (iso) return ymd(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const m = RE_SEP.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = fullYear(Number(m[3]));
    const runMonth = Number(runDate.slice(5, 7));

    if (a > 12 && b <= 12) return ymd(year, b, a); // a is the day
    if (b > 12 && a <= 12) return ymd(year, a, b); // b is the day
    // Ambiguous (both ≤ 12) → run-month anchor: the "7" is July-the-month.
    if (a === runMonth && b !== runMonth) return ymd(year, a, b); // a = month
    if (b === runMonth && a !== runMonth) return ymd(year, b, a); // b = month
    // Neither/both equal the run month → the sheet's own field order.
    return order === "MDY" ? ymd(year, a, b) : ymd(year, b, a);
  }

  return typeof serialCell === "number" ? serialToIso(serialCell) : null;
}
