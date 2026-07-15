// Google Sheets connector mapping helpers — Sheets-serial/text date parsing.
// Kept separate from sheets.ts per the dt-mapping.ts/odoo-mapping.ts
// convention: pure functions, unit-testable without a live Sheets API call.
//
// (Direction is NOT derived here — the live sheets encode it by which tab a
// row is on, Outward vs Inward, not by a column value. See sheets.ts.)

// Sheets serial date (days since the 1899-12-30 epoch) → "YYYY-MM-DD".
function fromSerial(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000); // 25569 = days 1899-12-30 → 1970-01-01
  return new Date(ms).toISOString().slice(0, 10);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

const RE_ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})/;
const RE_SLASH_OR_DASH = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/;

// Handles both a real Sheets serial number (a Date-typed cell, when the
// connector requests dateTimeRenderOption=SERIAL_NUMBER) and manually-typed
// text dates. Ambiguous DD/MM vs MM/DD slash/dash dates are read as
// DD/MM/YYYY — the ops teams entering these sheets are India-based.
export function parseSheetDate(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") return fromSerial(raw);

  const s = String(raw).trim();
  let m = RE_ISO.exec(s);
  if (m) return `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`;

  m = RE_SLASH_OR_DASH.exec(s);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    const year = Number(m[3]);
    if (month <= 12 && day <= 31) return `${year}-${pad(month)}-${pad(day)}`;
  }

  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}
