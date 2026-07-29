// Neutralising untrusted text before it reaches the model, and checking the
// vocabulary of what comes back.
//
// The injection surface is real and unusually literal here: `product`,
// `customer`, `so_number` and barcodes come from source systems including OCR of
// a HANDWRITTEN gate register — someone can write text on the page. Closure and
// submit notes are typed by portal users.
//
// The primary control is not this file: it is that no tool the model can call
// has a side effect. The worst achievable outcome is a wrong sentence, not a
// closed item or another city's data. This is defence in depth.

// C0/C1 controls, zero-width marks, and the BOM.
const INVISIBLE = new RegExp(
  "[" +
    "\u0000-\u001F" +
    "\u007F-\u009F" +
    "\u200B-\u200F" +
    "\u2028" + "\u2029" +
    "\u202A-\u202E" +
    "\u2060-\u2064" +
    "\uFEFF" +
    "]",
  "g"
);

/** Chat-structure tokens and instruction-shaped phrasing, neutralised. */
const STRUCTURE = /<\|[^|]*\|>|<\/s>|\[\/?INST\]|^\s*(system|assistant|user)\s*:/gim;
const INSTRUCTIONS =
  /ignore (all |the )?(previous|prior|above)|disregard (the )?(above|previous)|new instructions?|you are now|forget everything/gi;

export function sanitizeFreeText(value: string | null | undefined, max = 120): string | null {
  if (value == null) return null;
  let s = String(value)
    // Control characters and zero-width marks — invisible, and the usual way a
    // payload hides from a reviewer reading the row in a table.
    .replace(INVISIBLE, " ")
    .replace(/```+/g, " ")
    .replace(/^#{1,6}\s/gm, "")
    .replace(STRUCTURE, " ")
    .replace(INSTRUCTIONS, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s.length > 0 ? s : null;
}

/**
 * Internal vocabulary that must never reach a reader.
 *
 * Every pattern here is deliberately narrow, and the narrowness is the point:
 *   - REAL/INFO are matched CASE-SENSITIVELY, because "a real gap" and "for
 *     information" are ordinary English the assistant should be free to write;
 *   - "reco" is word-bounded, because "record" appears in 8 of the 22 canonical
 *     names and "Reconciliation Portal" is the product's own name.
 * A blunter regex would fire on correct output and train everyone to ignore it.
 */
export function containsBannedWords(text: string): string[] {
  const hits: string[] = [];
  const checks: [RegExp, string][] = [
    [/\bvariances?\b/i, "variance"],
    [/\bbuckets?\b/i, "bucket"],
    [/\bREAL\b/, "REAL"],
    [/\bINFO\b/, "INFO"],
    [/\breco\b/i, "reco"],
    // A raw responsible slug leaking through an unmapped team.
    [/\b\w+_team\b/, "team slug"],
  ];
  for (const [re, label] of checks) if (re.test(text)) hits.push(label);
  return hits;
}
