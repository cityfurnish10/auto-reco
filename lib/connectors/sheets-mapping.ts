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

function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.abs((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86400000);
}

// How far a serial can sit from the run date before we treat it as a
// locale-corrupted entry and believe the displayed string instead. The real
// posting/movement dates are within a day or two of the run; the corruption
// we've seen throws dates ~150 days off, so 25 cleanly separates the two.
const SERIAL_CORRUPTION_DAYS = 25;

// The one function the connector calls per row. `serialCell` is the raw
// UNFORMATTED value (a number for real date cells, a string for text-typed
// ones); `displayCell` is the FORMATTED value (what the operator sees/typed).
// Returns the row's business date, resolving the serial-vs-display conflict:
//   1. serial present & plausibly near the run  → trust the machine value
//      (handles DELHI: correct serial, US-format display).
//   2. serial corrupt/missing                    → trust the day-first display
//      (handles HYD/MUM: correct display, MM/DD-corrupted serial).
export function resolveSheetDate(
  serialCell: unknown,
  displayCell: unknown,
  runDate: string
): string | null {
  const serialIso = typeof serialCell === "number" ? serialToIso(serialCell) : parseDisplayDate(serialCell);
  const displayIso = parseDisplayDate(displayCell);

  if (serialIso && (!displayIso || daysBetween(serialIso, runDate) <= SERIAL_CORRUPTION_DAYS)) {
    return serialIso;
  }
  return displayIso ?? serialIso;
}
