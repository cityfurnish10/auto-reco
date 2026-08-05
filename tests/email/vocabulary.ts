// The banned-word assertions, shared by the digest and the follow-up.
//
// A helper rather than a copy in each file: the ban is meaningless if it is
// enforced on one email and quietly not on the other.

import { expect } from "vitest";

/**
 * Deliberately narrow, and the narrowness is the point.
 *
 * REAL and INFO are matched CASE-SENSITIVELY because "a real gap" and "for
 * information" are ordinary English the emails should be free to use. "reco" is
 * word-bounded because "record" appears in 8 of the 22 canonical names and
 * "Reconciliation Portal" is the product's own name. A blunter regex fires on
 * correct output and teaches everyone to ignore the check.
 */
const BANNED: [RegExp, string][] = [
  [/\bvariances?\b/i, "variance"],
  [/\bbuckets?\b/i, "bucket"],
  [/\bREAL\b/, "REAL"],
  [/\bINFO\b/, "INFO"],
  [/\breco\b/i, "reco"],
  [/\b\w+_team\b/, "a raw team slug"],
];

/**
 * Assert no internal vocabulary reaches a reader, across every surface given.
 *
 * `exempt` lists labels to skip FOR THESE SURFACES ONLY. It exists for exactly
 * one case: the owner set the subject line to "Guards Register Reco <date>"
 * (2026-08-05), and "reco" is on the list. The ban is here to stop the engine's
 * shorthand leaking into prose a warehouse owner reads — not to overrule the
 * owner on their own subject. Narrow on purpose: the body is still checked for
 * "reco", so this cannot become the hole the word walks back in through.
 */
export function expectNoJargon(
  surfaces: Record<string, string>,
  exempt: string[] = []
): void {
  for (const [where, text] of Object.entries(surfaces)) {
    for (const [re, label] of BANNED) {
      if (exempt.includes(label)) continue;
      expect(re.test(text), `${label} leaked into ${where}`).toBe(false);
    }
  }
}

/** Strip tags so the HTML body can be compared as prose. */
export const stripTags = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&middot;/g, "·")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const wordCount = (text: string): number =>
  text.trim().split(/\s+/).filter(Boolean).length;
