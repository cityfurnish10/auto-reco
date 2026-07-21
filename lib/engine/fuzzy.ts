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
  // First *alphanumeric* token — typed products carry a "# " prefix
  // ("# Washing Machine") the guard rows lack, so a plain whitespace split would
  // compare "#" against "washing" and never agree.
  const firstToken = (s: string) => (s.match(/[a-z0-9]+/) ?? [""])[0];
  const ta = firstToken(pa);
  const tb = firstToken(pb);
  return ta.length >= 3 && (ta === tb || ta.startsWith(tb) || tb.startsWith(ta));
}

// Strength of the guard-orphan → target match (0 = no match). ADDITIVE across
// signals, so a target agreeing on MORE identifiers outranks one agreeing on
// fewer. This is essential for multi-item deliveries: every line item of one
// delivery shares the same ticket (a delivery-level id), so an exact-ticket
// match alone ties across all of them — only the SO number or barcode (item-
// level ids) tells the items apart. Scoring ticket-alone as the top signal
// (the old first-match-wins order) made every such orphan an ambiguous tie and
// left it unmerged, surfacing a false "Missing from Gate Register" pair.
function matchScore(orphan: BarcodeView, target: BarcodeView): number {
  const os = alnum(orphan.soNumber);
  const ts = alnum(target.soNumber);
  const od = digits(orphan.soNumber);
  const td = digits(target.soNumber);

  // ── SO-CONFLICT VETO ── Both rows carry an order number and they DISAGREE
  // (full digits AND last-4 both differ) → different orders. Never merge, no
  // matter how well the barcode or a shared delivery ticket coincidentally line
  // up (a 70%-similar barcode or a multi-order delivery would otherwise fold two
  // different items together and silently hide a real gate-missing variance).
  if (od.length >= 4 && td.length >= 4 && od !== td && od.slice(-4) !== td.slice(-4)) return 0;

  let score = 0;

  // ── Item-level identifiers — unique per line item, so they DISAMBIGUATE. ──
  // Near-identical barcode (same length, ≥70% positions — OCR fold set applied).
  if (barcodeFuzzy(orphan.canonical, target.canonical)) score += 4;

  // Strong SO agreement — the SAME order number. Guard rows carry the bare
  // number ("84808") while typed sources wrap it ("ON-RET-BAN-84808"), so
  // compare on DIGITS (equal across that prefix gap) as well as full alnum text
  // (equal for pure-alpha refs). This is the reliable item-level key when the
  // barcode is un-OCR-able (e.g. "33") and the ticket got truncated.
  const soStrong = (od.length >= 4 && od === td) || (os.length >= 4 && os === ts);
  // SO last-4 alone is weak (unrelated items can share 4 trailing digits), so it
  // only counts when corroborated by the same delivery (ticket) or a matching
  // product — it can't, alone, name the right item.
  const soLast4 = !soStrong && od.length >= 4 && td.length >= 4 && od.slice(-4) === td.slice(-4);

  // ── Delivery-level identifier — SHARED across a delivery's items, so it ──
  // supports a match but can never, alone, pick between its line items.
  const ot = digits(orphan.ticketId);
  const tt = digits(target.ticketId);
  const ticketExact = ot.length >= 4 && ot === tt;
  const ticketNear = !ticketExact && ticketFuzzy(orphan.ticketId, target.ticketId);

  if (soStrong) score += 4;
  else if (soLast4 && (ticketExact || ticketNear || productAgrees(orphan.product, target.product)))
    score += 3;

  if (ticketExact) score += 2;
  else if (ticketNear) score += 1;

  return score;
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
