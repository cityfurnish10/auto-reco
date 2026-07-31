import type { DigestData } from "./types";

/**
 * Subject line: "Movement Register- 30-July-2026".
 *
 * Set by the owner, and deliberately carries no numbers. What it gives up is
 * recorded here because it was load-bearing: the old subject led with the
 * tier-1 count inside the first 45 characters (Gmail on mobile truncates near
 * 40), named the cities carrying it, refused an all-clear while any live city
 * was short its guard register, and replaced everything with "the check did not
 * finish, do not act on these figures" on an incomplete run. None of that is
 * visible now until the mail is opened.
 */
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function digestSubject(data: DigestData): string {
  const [y, m, d] = String(data.date).split("-").map(Number);
  const date = y && m && d ? `${d}-${MONTHS[m - 1]}-${y}` : String(data.date);
  return `Movement Register- ${date}`;
}
