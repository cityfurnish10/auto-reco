// Section 5 — Barcode Handling: validity, canonicalization, spare detection.

const PLACEHOLDERS = new Set(["n/a", "na", "-", "--", ""]);

// OCR/handwriting confusions to fold — do NOT widen this table (Section 5).
const FOLD: Record<string, string> = {
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
