// The barcode to put in front of a person.
//
// THE PROBLEM THIS SOLVES. canonicalize() folds I→1, O→0, S→5, Z→2, G→6 so a
// photographed handwritten guard register matches the typed systems. That fold
// is the grouping key, and the engine stored it as the barcode, so every screen
// and every email printed a string that may exist in no system at all.
//
// Measured 2026-08-05 over 128,411 retained source rows: of 4,190 units a typed
// source witnessed, 2,392 — 57.1% — displayed a canonical matching none of the
// spellings Odoo, DT or the ops sheet recorded. Two were reported from the floor
// the same day, and the sharper one was an Odoo serial: AP8IS725090229 rendered
// as AP815725090229, so pasting the row into Odoo returned "no product move"
// and a correct finding read as an invented one.
//
// Migration 0020 adds barcode_display, written from the raw spelling a typed
// source recorded. This is the ONE place that decides what to show, so a new
// screen cannot quietly go back to printing the fold.
//
// NEVER USE THIS TO LOOK SOMETHING UP. `barcode` is the canonical: it is half
// the variances dedup key, it is what movement_events keys on, and it is what
// source_rows.barcode_canonical joins to. This value is a label.

/** Any row carrying the pair. `barcode_display` is absent pre-0020 and on old rows. */
export interface HasBarcode {
  barcode: string;
  barcode_display?: string | null;
}

/**
 * What to render. Falls back to the canonical, which is exactly what every
 * surface showed before 0020 — so an unapplied migration, a row written before
 * it, and a unit no typed source ever spelled all degrade to today's behaviour
 * rather than to a blank.
 */
export function shownBarcode(row: HasBarcode | null | undefined): string {
  if (!row) return "";
  const display = row.barcode_display?.trim();
  return display && display.length > 0 ? display : row.barcode;
}
