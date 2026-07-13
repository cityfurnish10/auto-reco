// Section 3 — Run-Date Derivation, plus the shared date parser.
// Handles ISO strings, Excel serials, and d/m/y or m/d/y with / - . or
// separators (day-first when ambiguous). Parsing failures are explicit:
// deriveRunDate throws rather than emitting a report for the wrong day.

import { pad } from "./util";
import type { SourceRow } from "./types";

function excelSerialToDate(serial: number): string {
  // Excel epoch is 1899-12-30 (accounts for the 1900 leap-year bug).
  const ms = Math.round(serial) * 86400000 + Date.UTC(1899, 11, 30);
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
    d.getUTCDate()
  )}`;
}

function fmt(year: number, month: number, day: number): string | null {
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function parseDate(
  raw: string | number | undefined | null
): string | null {
  if (raw === undefined || raw === null || raw === "") return null;

  if (typeof raw === "number") {
    if (raw > 59 && raw < 80000) return excelSerialToDate(raw);
    return null;
  }

  const s = raw.toString().trim();
  if (!s) return null;

  // Numeric string → likely an Excel serial.
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 59 && n < 80000) return excelSerialToDate(n);
  }

  // ISO (YYYY-MM-DD…)
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // d/m/y or m/d/y or y/m/d with / - . separators
  const m = s.match(/^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{1,4})$/);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    const c = parseInt(m[3], 10);

    // 4-digit leading field → year-first (Y/M/D).
    if (m[1].length === 4) return fmt(a, b, c);

    // Otherwise default day-first (a=day, b=month, c=year)…
    let day = a;
    let month = b;
    const year = c;
    // …unless that's impossible and swapping makes it valid (m/d/y input).
    if (day > 31) return null;
    if (month > 12 && day <= 12) {
      const t = day;
      day = month;
      month = t;
    }
    return fmt(year, month, day);
  }

  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
      d.getUTCDate()
    )}`;
  }
  return null;
}

export function addDays(date: string, n: number): string {
  const [y, mo, d] = date.split("-").map(Number);
  const ms = Date.UTC(y, mo - 1, d) + n * 86400000;
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(
    dt.getUTCDate()
  )}`;
}

// Section 3: take the most common parseable date across physical + DT rows.
// Deterministic tie-break: higher count, then latest date.
export function deriveRunDate(rows: SourceRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.source !== "PHYSICAL" && row.source !== "DT") continue;
    const parsed = parseDate(row.date);
    if (parsed) counts.set(parsed, (counts.get(parsed) ?? 0) + 1);
  }

  if (counts.size === 0) {
    throw new Error(
      "Run-date derivation failed: no parseable date in any physical or DT row"
    );
  }

  return Array.from(counts.entries()).sort((a, b) =>
    b[1] !== a[1] ? b[1] - a[1] : b[0].localeCompare(a[0])
  )[0][0];
}
