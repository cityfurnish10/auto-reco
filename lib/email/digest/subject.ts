import type { DigestData } from "./types";

/**
 * Subject line: "Guard Register Reco 05-08-2026".
 *
 * Owner's wording. It was "Movement Register- 30-July-2026", then "Guards
 * Register Reco 4-August-2026" (2026-08-05), now singular with an all-digit
 * day-month-year date (2026-08-06). Both parts are zero-padded, so every
 * subject is the same length and a month of them lines up in an inbox.
 *
 * Set by the owner, and deliberately carries no numbers. What it gives up is
 * recorded here because it was load-bearing: the old subject led with the
 * tier-1 count inside the first 45 characters (Gmail on mobile truncates near
 * 40), named the cities carrying it, refused an all-clear while any live city
 * was short its guard register, and replaced everything with "the check did not
 * finish, do not act on these figures" on an incomplete run. None of that is
 * visible now until the mail is opened.
 */
const pad = (n: number) => String(n).padStart(2, "0");

export function digestSubject(data: DigestData): string {
  const [y, m, d] = String(data.date).split("-").map(Number);
  // Falls back to the raw ISO string rather than rendering "NaN-NaN-NaN" if the
  // date is ever malformed — the subject is the one line that always ships.
  const date = y && m && d ? `${pad(d)}-${pad(m)}-${y}` : String(data.date);
  return `Guard Register Reco ${date}`;
}
