// OCR-tolerant fuzzy matching for guard-register rows.
//
// When the guard's handwritten barcode is mis-OCR'd beyond the canonicalize()
// fold set (O/0 I/1 S/5 Z/2 G/6), it produces a *different* canonical than the
// typed sources and forms its own isolated BarcodeView — raising two false REAL
// variances (a P-only "Gate-Only Dispatch" and the real item's "Gate Log
// Missing"). This layer re-links a guard orphan to the correct typed-source item
// when the TICKET, SO/PO, or a near-identical BARCODE agrees, so run.ts can merge
// it in and the false variance is resolved rather than raised.

import { canonicalize } from "./barcode";
import type { BarcodeView } from "./types";

export const BARCODE_MATCH_RATIO = 0.7; // same-length positional match cutoff
const TICKET_MATCH_RATIO = 0.66; // ≥4 of 6

const digits = (s: string | null | undefined) => (s ?? "").replace(/[^0-9]/g, "");
const alnum = (s: string | null | undefined) => (s ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();

function positionalRatio(a: string, b: string): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

// Barcode: same length AND ≥70% of positions equal, compared on canonicalize()
// output (so the standard O/0 · I/1 · S/5 · Z/2 · G/6 folds are already applied).
export function barcodeFuzzy(a: string, b: string): boolean {
  const ca = canonicalize(a);
  const cb = canonicalize(b);
  if (ca.length < 5 || ca.length !== cb.length) return false;
  if (ca === cb) return true;
  return positionalRatio(ca, cb) >= BARCODE_MATCH_RATIO;
}

// Ticket: digits only; exact, or same length (≥4) with ≥~66% positions equal (≥4/6).
export function ticketFuzzy(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = digits(a);
  const db = digits(b);
  if (da.length < 4 || db.length < 4 || da.length !== db.length) return false;
  if (da === db) return true;
  return positionalRatio(da, db) >= TICKET_MATCH_RATIO;
}

// SO / PO: alphanumerics; exact, or the last 4 characters match.
export function soFuzzy(a: string | null | undefined, b: string | null | undefined): boolean {
  const sa = alnum(a);
  const sb = alnum(b);
  if (sa.length < 4 || sb.length < 4) return false;
  if (sa === sb) return true;
  return sa.slice(-4) === sb.slice(-4);
}

// Loose product agreement — first token matches / one is a prefix of the other.
// Used only as a safety gate for the weakest signal (SO last-4 alone).
function productAgrees(a: string | null, b: string | null): boolean {
  const pa = (a ?? "").trim().toLowerCase();
  const pb = (b ?? "").trim().toLowerCase();
  if (!pa || !pb) return false;
  const ta = pa.split(/\s+/)[0];
  const tb = pb.split(/\s+/)[0];
  return ta.length >= 3 && (ta === tb || pa.startsWith(tb) || pb.startsWith(ta));
}

// Strength of the guard-orphan → target match (0 = no match). Strongest first.
function matchScore(orphan: BarcodeView, target: BarcodeView): number {
  const ot = digits(orphan.ticketId);
  if (ot.length >= 4 && ot === digits(target.ticketId)) return 3; // exact ticket
  const os = alnum(orphan.soNumber);
  if (os.length >= 4 && os === alnum(target.soNumber)) return 3; // exact SO/PO
  if (barcodeFuzzy(orphan.canonical, target.canonical)) return 2; // near-identical barcode
  if (ticketFuzzy(orphan.ticketId, target.ticketId)) return 2; // fuzzy ticket
  // Weakest signal — SO/PO last-4 only — gated on product agreement to avoid
  // coincidental merges across different items that share the last 4 digits.
  if (soFuzzy(orphan.soNumber, target.soNumber) && productAgrees(orphan.product, target.product))
    return 1;
  return 0;
}

// Best matching target for a guard orphan, or null if none / an ambiguous tie
// (two+ targets share the top score — skip rather than mis-merge).
export function bestGuardMatch(orphan: BarcodeView, targets: BarcodeView[]): BarcodeView | null {
  let best: BarcodeView | null = null;
  let bestScore = 0;
  let tie = false;
  for (const t of targets) {
    const s = matchScore(orphan, t);
    if (s > bestScore) {
      bestScore = s;
      best = t;
      tie = false;
    } else if (s === bestScore && s > 0) {
      tie = true;
    }
  }
  return bestScore > 0 && !tie ? best : null;
}
