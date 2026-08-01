// Which books saw a unit, and what to do about each combination.
//
// PURE — every label and every invariant below is a unit test with no database.
//
// The four books, always in this order: the gate register (P, "guard"), the ops
// sheet (S), the delivery app (D) and Odoo (O). A movement is seen by at least
// one of them, so there are 15 possible patterns, and each unit has exactly
// ONE — which is what lets a city's rows be added up against its own total.
//
// Measured 27-31 Jul 2026 across all five cities: 12 of the 15 actually occur.
// The three that never have are P-DO, P--O and P-D-, all "guard wrote it down
// but the ops sheet did not" shapes. They still carry labels: a pattern that has
// not happened yet is not a pattern that cannot.
//
// Frequency over that window — the guard register dominates every gap:
//   -SDO 953 · ---O 808 · -S-O 527 · PSDO 479 · --DO 315 · -S-- 212
//   PS-O 124 · P--- 112 · --D-  85 · PS--  61 · -SD-  27 · PSD-   1

import type { CityCoverage, SourceKey } from "./coverage";

/** Book order for every pattern key, mark array and column header. */
export const SOURCE_ORDER: SourceKey[] = ["P", "S", "D", "O"];

/** Column headers, in SOURCE_ORDER. The owner's words, not the engine's. */
export const SOURCE_LABEL: Record<SourceKey, string> = {
  P: "Guard",
  S: "Sheet",
  D: "DT",
  O: "Odoo",
};

/**
 * What each combination means, in the imperative where there is something to do.
 *
 * Written for a warehouse owner, not an engineer: no book is named by its
 * table, and nothing here says "variance". The phrasing names the ABSENT books,
 * because the present ones are already visible as ticks on the row.
 */
export const PATTERN_ACTION: Record<string, string> = {
  // Nothing missing.
  PSDO: "All clear",

  // One book short.
  "-SDO": "Guard post not logging",
  "P-DO": "Sheet entry missed",
  "PS-O": "DT app not scanned",
  "PSD-": "Not posted in Odoo",

  // Two books short.
  "--DO": "Guard + sheet both skipped",
  "-S-O": "Guard + DT both skipped",
  "-SD-": "No guard, and not posted in Odoo",
  "P--O": "Sheet + DT both skipped",
  "P-D-": "No sheet, and not posted in Odoo",
  "PS--": "On paper only — neither app nor Odoo",

  // Three books short — one lonely record.
  "---O": "Only Odoo has it — off-system?",
  "--D-": "Only the delivery app has it",
  "-S--": "Only the sheet has it",
  "P---": "Only the guard saw it",
};

/** The row label used when the long tail is folded together. */
export const OTHER_ROW_LABEL = "Other combinations";

/** How many patterns a city shows before the rest collapse into one row. */
export const DEFAULT_PATTERN_LIMIT = 6;

/**
 * A tick, a cross, or "this book never filed".
 *
 * THE DISTINCTION IS THE WHOLE POINT. Measured 30 Jul: Mumbai's guard register
 * and ops sheet did not file at all. Rendering those as a cross would accuse a
 * warehouse of failing to log on a day nobody asked it to — the same
 * flattering-direction-in-reverse error the coverage gating exists to prevent.
 */
export type Mark = "yes" | "no" | "na";

export interface PatternRow {
  /** "PSDO", "-SDO", or "" for the collapsed remainder. */
  key: string;
  marks: Mark[];
  count: number;
  action: string;
  /** 0-100, this row against the city's biggest row — the bar width. */
  share: number;
}

/**
 * A city's patterns as table rows, biggest first, long tail collapsed.
 *
 * ROWS ALWAYS SUM TO `c.total`. The collapse folds the remainder into one row
 * rather than dropping it, so a reader can still add the column up and get the
 * city's own movement count. A table whose numbers do not reconcile with the
 * line above it is worse than no table.
 */
export function patternRows(
  c: CityCoverage,
  limit: number = DEFAULT_PATTERN_LIMIT
): PatternRow[] {
  const entries = Object.entries(c.patterns ?? {})
    .filter(([, n]) => n > 0)
    // Count desc, then key, so two equal counts never swap between renders.
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const head = entries.slice(0, limit);
  const tail = entries.slice(limit);
  const tailCount = tail.reduce((s, [, n]) => s + n, 0);
  const biggest = entries[0]?.[1] ?? 0;
  const share = (n: number) => (biggest > 0 ? Math.round((n / biggest) * 100) : 0);

  const rows: PatternRow[] = head.map(([key, count]) => ({
    key,
    marks: SOURCE_ORDER.map((k, i) =>
      // A book that never filed is "na" whatever the pattern says — its absence
      // from this unit carries no information about the warehouse.
      !c.reported[k] ? "na" : key[i] === "-" ? "no" : "yes"
    ),
    count,
    action: actionFor(key, c),
    share: share(count),
  }));

  if (tailCount > 0) {
    rows.push({
      key: "",
      marks: SOURCE_ORDER.map(() => "na"),
      count: tailCount,
      action: `${OTHER_ROW_LABEL} (${tail.length})`,
      share: share(tailCount),
    });
  }
  return rows;
}

/**
 * The action phrase, blaming only books that actually filed.
 *
 * When a book did not file, its absence from a unit is not a finding, so the
 * generic label — which names it — would be wrong. Fall back to describing what
 * the books that DID file saw.
 */
export function actionFor(key: string, c: CityCoverage): string {
  const allReported = SOURCE_ORDER.every((k) => c.reported[k]);
  if (allReported) return PATTERN_ACTION[key] ?? "";

  const filed = SOURCE_ORDER.filter((k) => c.reported[k]);
  const present = filed.filter((k) => key[SOURCE_ORDER.indexOf(k)] !== "-");
  const absent = filed.filter((k) => key[SOURCE_ORDER.indexOf(k)] === "-");
  if (absent.length === 0) return "In every book that filed";
  if (present.length === 0) return "In none of the books that filed";
  return `Missing from ${absent.map((k) => SOURCE_LABEL[k]).join(" + ")}`;
}

/** Which books filed, for the line under a city that is short one. */
export function filedNote(c: CityCoverage): string | null {
  const missing = SOURCE_ORDER.filter((k) => !c.reported[k]);
  if (missing.length === 0) return null;
  const filed = SOURCE_ORDER.filter((k) => c.reported[k]).map((k) => SOURCE_LABEL[k]);
  const names = missing.map((k) => SOURCE_LABEL[k]);
  const list =
    names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  return filed.length === 0
    ? "No book filed for this city today."
    : `${list} did not file today — those columns are blank, not a miss.`;
}
