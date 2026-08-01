// OCR noise defenses for the guard register — summary lines, stray-character
// repairs, and a plausibility grammar. PURE: every rule here is a unit test.
//
// WHY THIS EXISTS. Measured on the live queue 2026-08-01: of 50 open
// "Gate Register Only" HIGHs, 26 were OCR artifacts, not stock —
//
//   3  the register's own footer lines parsed as movements. The parser
//      reconstructs the per-character barcode boxes by concatenating a narrow
//      column band, so "COUNT 014 ITEMS" written across the boxes becomes the
//      barcode C0UNT0141TEM5 (with the canonical fold applied), "61 ITEMS OUT"
//      becomes 611TEN50UT, and a "Total 9" line ships with product "Total 9".
//  18  real barcodes with one stray or confused character the same-length
//      fuzzy matcher cannot see: 6AP815719030952 is AP815719030952 with a
//      leading stray, FUM4HA230300627 is FUMYHA23030062 with a substitution
//      and a trailing stray.
//   5  unparseable fragments (N42150, 08166F, 17+-char reads).
//
// Ground truth for "plausible": 13,674 system-typed barcodes measured 99.6%
// pure alphanumeric, 93% exactly 14 chars, 96%+ within 13-16.
//
// NOTHING HERE CANONICALIZES. The FOLD table in barcode.ts is mirrored in SQL
// by migration 0014 and must not widen (write-time canonicalization; widening
// strands history). foldClass below is a COMPARE-TIME equivalence class only.

/**
 * Digit→letter normalization for WORD detection, the inverse direction of the
 * canonical fold: canonical turns COUNT into C0UNT (O→0), so detecting the
 * word means mapping digits back. Non-letters are stripped after mapping, so
 * the result is a letters-only string to run word regexes over.
 */
export function wordClass(s: string): string {
  return String(s ?? "")
    .toUpperCase()
    .replace(/0/g, "O")
    .replace(/1/g, "I")
    .replace(/5/g, "S")
    .replace(/8/g, "B")
    .replace(/4/g, "A")
    .replace(/[^A-Z]/g, "");
}

/**
 * Words that appear in register furniture — totals, footers, page headers —
 * and never inside a genuine barcode. ITEN covers the measured "611TEN50UT"
 * shape, where the 6 is unmappable and strips out.
 */
export const SUMMARY_RE = /(COUNT|ITEMS?|ITEN|TOTAL|TOTA|PAGE|SIGNAT|REGISTER|CARR(IED)?|FORWARD)/;

/**
 * Is this parsed row the register's own summary/total line rather than a
 * movement? Tested on BOTH fields: the barcode band swallows footer text
 * ("COUNT 014 ITEMS" → C0UNT0141TEM5) and the product column swallows the rest
 * ("Total 9", "count", the clipped "e parts" line's neighbours).
 */
export function isSummaryLine(barcode: string, product?: string | null): boolean {
  const p = String(product ?? "").trim();
  if (SUMMARY_RE.test(wordClass(barcode))) return true;
  if (p !== "") {
    if (/^total\s*\d*$/i.test(p)) return true;
    const pw = wordClass(p);
    if (pw === "COUNT" || SUMMARY_RE.test(pw)) return true;
  }
  return false;
}

/**
 * Compare-time confusable class: the canonical FOLD (I/1 O/0 S/5 Z/2 G/6) plus
 * the pairs OCR confuses that canonicalize deliberately excludes (L→1, B→8).
 * Two spellings in the same class are "the same barcode as far as a camera is
 * concerned". NEVER stored, NEVER canonicalized with — see the 0014 invariant.
 */
export function foldClass(s: string): string {
  return String(s ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/[O0]/g, "0")
    .replace(/[I1L]/g, "1")
    .replace(/[S5]/g, "5")
    .replace(/[Z2]/g, "2")
    .replace(/[G6]/g, "6")
    .replace(/[B8]/g, "8");
}

/** Levenshtein distance ≤ max, bounded early. */
export function editWithin(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  if (a === b) return true;
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    let rowMin = dp[0];
    for (let j = 1; j <= b.length; j++) {
      const t = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
      if (dp[j] < rowMin) rowMin = dp[j];
    }
    if (rowMin > max) return false;
  }
  return dp[b.length] <= max;
}

/**
 * Are two barcodes the same physical label, allowing ONE stray character at
 * either end plus ONE confusable-class edit? This is precisely the shape the
 * same-length positional matcher in fuzzy.ts cannot see — a stray character
 * changes the length, and every one of the 18 measured repairs scored zero
 * there. Each stripped variant must keep ≥10 characters so a short fragment
 * cannot bulldoze its way into a match.
 */
export function classNear(a: string, b: string): boolean {
  const ca = foldClass(a);
  const cb = foldClass(b);
  if (ca.length < 10 || cb.length < 10) return false;
  const variants = [ca, ca.slice(1), ca.slice(0, -1), ca.slice(1, -1)];
  for (const v of variants) {
    if (v.length < 10) continue;
    if (editWithin(v, cb, 1)) return true;
  }
  return false;
}

/**
 * A gate-only barcode no plausible label could produce, measured against the
 * system-typed grammar (99.6% alphanumeric, 93% exactly 14 chars): too short,
 * too long, nearly digit-free, or carrying characters no label has. Applied
 * ONLY to P-only orphans after the merge pass — a row any typed system also
 * saw is real by definition.
 */
export function grammarSuspect(barcode: string): boolean {
  const s = String(barcode ?? "").trim();
  if (s.length < 10 || s.length > 17) return true;
  if (!/^[A-Z0-9]+$/i.test(s)) return true;
  if ((s.match(/\d/g) ?? []).length < 4) return true;
  return false;
}
