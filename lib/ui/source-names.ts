// The four books, named once.
//
// Asked for on 15 Sep 2026: one vocabulary across the screens and the emails.
// Before this the same source was "Gate Register" in a variance name, "Physical"
// on a badge, "Gate register" on the scoreboard and "the guard" in an email —
// four words for one book, and a reader had to learn all four to follow a row
// from a dashboard to an inbox.
//
// PRESENTATION ONLY. The stored values (`Physical`, `Sheet`, `DT`, `Odoo` in
// variances.variance_source, and the source codes inside the engine) are
// untouched: they are written on every historical row and are what every filter
// and every query matches on. Renaming those would orphan the 4,000+ rows
// already stored — and the six obsolete variance names still sitting in the
// table are the standing proof of what that costs.
//
// So: change the word, never the value.

import type { VarianceSource } from "../db/schema";

/** What each book is called, everywhere a person reads it. */
export const SOURCE_NAME = {
  odoo: "Odoo",
  sheet: "Manual Sheet",
  dt: "Delivery Tracker",
  gate: "Guard Check",
} as const;

/**
 * The stored `variance_source` code → its name.
 *
 * "Cross" is not one of the four books: it is raised when the sources conflict
 * with each other rather than one of them being silent, so it is named for what
 * it is rather than given a book's name.
 */
export const SOURCE_LABEL: Record<VarianceSource, string> = {
  Odoo: SOURCE_NAME.odoo,
  Sheet: SOURCE_NAME.sheet,
  DT: SOURCE_NAME.dt,
  Physical: SOURCE_NAME.gate,
  Cross: "Cross-check",
};

export const sourceLabel = (s: VarianceSource | null | undefined): string =>
  (s && SOURCE_LABEL[s]) || "—";
