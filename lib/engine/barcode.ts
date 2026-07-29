// Section 5 — Barcode Handling: validity, canonicalization, spare detection.

const PLACEHOLDERS = new Set(["n/a", "na", "-", "--", ""]);

// OCR/handwriting confusions to fold — do NOT widen this table (Section 5).
//
// Exported so a test can pin its shape. Migration 0014 reproduces this table in
// SQL (canonicalize_barcode) to give source_rows a canonical column, and the two
// must agree exactly: variances.barcode is canonicalized at WRITE time, so
// widening the fold would leave historical rows on the old canonical while new
// source rows use the new one, and the join between them would break silently
// for past dates. Repairing that is not a simple UPDATE either — two old
// canonicals collapsing into one violates the variances unique key.
export const FOLD: Record<string, string> = {
  I: "1",
  O: "0",
  S: "5",
  Z: "2",
  G: "6",
};

export function isSpareOrConsumable(raw: string): boolean {
  const s = raw.trim().toLowerCase();
  return s.includes("spare") || s.includes("consumable");
}

// A sheet row whose ITEM NAME reads "Not Found" is almost always a spare or
// consumable: the warehouse types a description into the barcode column
// ("WP water seal - 13", "Spin Motor - 3", "@ Packing Tape Roll") and the
// product lookup then finds nothing. Measured on live data — of 219 such rows,
// 217 appeared in no other system at all, and their ops types read "Spare Items
// IN" / "Spare Parts" / "PO inward".
//
// NOT sufficient on its own, which is why callers must pair it with the
// corroboration guard in run.ts: the other 2 rows were real Odoo lot serials
// (FUCQPU26070002, "# Luna Wardrobe") whose sheet line simply had the product
// column blank. Diverting those to the count layer would erase a genuine
// receipt from reconciliation.
export function looksUnresolvedItem(raw: string | undefined | null): boolean {
  if (!raw) return false;
  const s = raw.trim().toLowerCase();
  return s === "not found" || s === "notfound" || s === "not-found";
}

// PP boxes (packing boxes) are logged in the ops sheet / guard register as
// free-text counts ("PP BOX - 29", "PP Box 32\" TV - 03"), not real barcodes.
// They must never run the per-barcode ladder — surfaced as one count-only
// INFO row per direction instead (see run.ts).
export function isPpBox(raw: string): boolean {
  return /\bpp\s*box/i.test(raw);
}

// Valid = ≥5 chars, ≥1 alphanumeric, not a placeholder. Spare/consumable is
// handled separately (surfaced as an INFO variance, not dropped here).
export function isValidBarcode(raw: string): boolean {
  const s = raw.trim();
  if (s.length < 5) return false;
  if (!/[a-z0-9]/i.test(s)) return false;
  if (PLACEHOLDERS.has(s.toLowerCase())) return false;
  return true;
}

export function canonicalize(raw: string): string {
  const upper = raw.toUpperCase().replace(/\s+/g, "");
  let out = "";
  for (const ch of upper) out += FOLD[ch] ?? ch;
  return out;
}
