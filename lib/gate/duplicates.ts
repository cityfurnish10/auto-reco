// Which gate entries are duplicates of an earlier one.
//
// Decided 14 Sep 2026: "do not take duplicate entries, only unique entries,
// flag as duplicate entry in all scenarios". The first entry stands; every
// later copy is flagged, kept visible, and left out of every count.
//
// THREE SCENARIOS, because a duplicate looks different depending on what the
// entry carries:
//
//   1. SCANNED BARCODE — the same unit, same direction, same business day, on
//      ANY trip. A unit cannot leave twice without coming back in between, so a
//      second outward scan is a second log of one movement whichever truck it
//      landed on. Compared on the canonical fold, as the engine matches.
//
//   2. TYPED IDENTIFIER — a hand entry with a serial, SO or ticket typed in.
//      Same rule as a barcode: same identifier, same direction, same day. Delhi,
//      13 Sep: one mattress entered three times as "138193047", 3ms apart, and a
//      vendor delivery "PO-TYUI-BJ900 · WM -10 QTY" twice.
//
//   3. NOTHING TO IDENTIFY IT — a counted hand entry (spare part, PP box…). Two
//      spare parts on one truck are normal, so these are only duplicates when
//      everything matches — trip, kind, quantity, note — AND they were saved
//      within DOUBLE_SAVE_MS of each other: the signature of a repeated tap, not
//      of a second item.
//
// Pure, so the Activity page and anything else that counts entries agree. The
// reconciliation needs none of this: it reads scanned barcodes only, and the
// engine already counts a repeated barcode once and flags it "Duplicate Scan".

import { canonicalize } from "../engine/barcode";

export const DOUBLE_SAVE_MS = 2 * 60_000;

export interface DupEntry {
  id: string;
  tripId: string | null;
  city: string | null;
  businessDate: string | null;
  direction: string | null;
  barcode: string | null;
  serialNo: string | null;
  soNumber: string | null;
  ticketId: string | null;
  itemKind: string | null;
  quantity: number | null;
  notes: string | null;
  scannedAt: string;
}

export interface DuplicateFlag {
  /** The entry this repeats — the first one, which is the one counted. */
  of: string;
  ofScannedAt: string;
  reason: "same barcode" | "same identifier" | "repeated save";
}

const clean = (v: string | null | undefined) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export function findDuplicates(entries: DupEntry[]): Map<string, DuplicateFlag> {
  const out = new Map<string, DuplicateFlag>();
  const ordered = [...entries].sort((a, b) => a.scannedAt.localeCompare(b.scannedAt) || a.id.localeCompare(b.id));
  const firstByKey = new Map<string, DupEntry>();
  const lastCounted = new Map<string, DupEntry>();

  for (const e of ordered) {
    const day = `${e.city ?? ""}|${e.businessDate ?? ""}|${e.direction ?? ""}`;
    const barcode = e.barcode?.trim() ? canonicalize(e.barcode.trim()) : "";
    const typed = clean(e.serialNo) || clean(e.soNumber) || clean(e.ticketId);

    if (barcode || typed) {
      const key = barcode ? `B|${day}|${barcode}` : `T|${day}|${typed}`;
      const first = firstByKey.get(key);
      if (first) {
        out.set(e.id, { of: first.id, ofScannedAt: first.scannedAt, reason: barcode ? "same barcode" : "same identifier" });
      } else {
        firstByKey.set(key, e);
      }
      continue;
    }

    const key = `C|${e.tripId ?? ""}|${e.direction ?? ""}|${e.itemKind ?? ""}|${e.quantity ?? 1}|${(e.notes ?? "").trim().toLowerCase()}`;
    const prev = lastCounted.get(key);
    if (prev && Date.parse(e.scannedAt) - Date.parse(prev.scannedAt) <= DOUBLE_SAVE_MS) {
      const root = out.get(prev.id)?.of ?? prev.id;
      const rootAt = out.get(prev.id)?.ofScannedAt ?? prev.scannedAt;
      out.set(e.id, { of: root, ofScannedAt: rootAt, reason: "repeated save" });
    }
    // The window runs from the latest save, so three taps a minute apart are
    // still one item — but two genuine saves ten minutes apart are two.
    lastCounted.set(key, e);
  }
  return out;
}
