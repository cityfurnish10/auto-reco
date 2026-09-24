// The structured phrase under a variance's short name.
//
// Agreed 15 Sep 2026. Two grammars and no third:
//
//   presence   "Seen by A + B · Missing from C"     who holds the record
//   event      "What happened · detail"             something specific occurred
//
// The engine's own names grew one at a time over months and read like twenty
// separate decisions — "Gate Register Only — No Ops / DT / Odoo Record" beside
// "DT-Only — Fake Scan Risk". The information was right and the reader had to
// re-learn the format on every row.
//
// PRESENTATION ONLY, and this is the point of the file. variance_name is
// written onto every stored row: 4,000+ rows across 30 distinct spellings,
// SIX of which no version of this code produces any more. Renaming the
// constants would leave every one of those rows speaking an older language and
// would split each filter in two. So the stored name stays the key and this is
// the sentence shown beside it — which also lets the six obsolete names be
// mapped onto current wording, something a rename could never do.
//
// Keyed by the literal stored string rather than by VARIANCE.*, because the
// obsolete names have no constant to key on.

import { SOURCE_NAME as S } from "./source-names";

const PHRASE: Record<string, string> = {
  // ── Chase list ─────────────────────────────────────────────────────────
  "Gate Register Only — No Ops / DT / Odoo Record": `Seen by ${S.gate} only · No other record`,
  "Ops Sheet Only — No Gate / DT / Odoo Record": `Seen by ${S.sheet} only · No other record`,
  "DT Only — No Floor or Odoo Record": `Seen by ${S.dt} only · No other record`,
  "Odoo Entry Created Today — No Gate / Ops / DT Record": `Seen by ${S.odoo} only · Entry created that day`,
  "Moved on Floor + DT — Not Posted in Odoo": `Seen by ${S.gate} + ${S.dt} · Missing from ${S.odoo}`,
  "Gate + Ops Confirm — No DT Scan or Odoo Post": `Seen by ${S.gate} + ${S.sheet} · Missing from ${S.dt} + ${S.odoo}`,
  "Pickup Logged (Gate + DT) — Odoo Receipt Open": `Seen by ${S.gate} + ${S.dt} · ${S.odoo} receipt still open`,
  "Wrong Barcode Scanned in DT": `Wrong unit scanned · ${S.dt}`,
  "Same Unit In + Out Today — Confirm Replacement": "Same unit in and out · Confirm replacement",
  "Failed Delivery — Return Not Logged Inward": "Failed delivery · Return not logged inward",
  "ODD HOUR TRIP — Movement at a Time the Gate Rarely Sees": `Odd hour · Trip at a time the gate rarely sees`,
  "OT CASE — Order Transfer in Odoo, Map Manually": `OT case · Order transfer in ${S.odoo}, map by hand`,
  "Ops Sheet Says Not Delivered — Posted Done in DT/Odoo": `${S.sheet} says not delivered · ${S.odoo} and ${S.dt} say done`,

  // ── For information ────────────────────────────────────────────────────
  "Ops + Odoo Confirm — Missing from Gate Register": `Seen by ${S.sheet} + ${S.odoo} · Missing from ${S.gate}`,
  "Ops + Odoo Confirm — No DT Scan": `Seen by ${S.sheet} + ${S.odoo} · Missing from ${S.dt}`,
  "DT + Odoo Confirm — Missing from Ops Sheet": `Seen by ${S.dt} + ${S.odoo} · Missing from ${S.sheet}`,
  "Gate + Ops + Odoo Confirm — DT Scan Pending": `Seen by ${S.gate} + ${S.sheet} + ${S.odoo} · Missing from ${S.dt}`,
  "Gate + Odoo Confirm — No Ops Sheet or DT Scan": `Seen by ${S.gate} + ${S.odoo} · Missing from ${S.sheet} + ${S.dt}`,
  "Ops + DT Confirm — Odoo Posting Pending": `Seen by ${S.sheet} + ${S.dt} · ${S.odoo} posting pending`,
  "Odoo Posting Only — No Gate / Ops / DT Record": `Seen by ${S.odoo} only · No floor record`,
  "Odoo Entry Made Late — Posted Next Day": `${S.odoo} posted late · Next day`,
  "Odoo Entry Made Late — Posted a Few Days On": `${S.odoo} posted late · Two days or more`,
  "Items In Transit — Odoo Out Not Yet Validated": `In transit · ${S.odoo} Out not validated`,
  "Entry Dated Wrong Day — Unit Logged on Adjacent Day": "Logged a day either side",
  "All Sources Agree — Barcode Text Differs (OCR/Typo)": "All four agree · Barcode text differs",
  "Duplicate Scan — Same Barcode Logged Twice": "Duplicate scan · Same barcode twice",

  // ── Obsolete, still stored ─────────────────────────────────────────────
  // No current code path produces these; they are on rows from earlier versions
  // and a reader should not have to know that. Mapped onto the phrase their
  // successor uses, so an old row reads like a current one.
  "Odoo-Only Entry — No Floor Record": `Seen by ${S.odoo} only · No floor record`,
  "Register/DT Logged — Not in Odoo": `Seen by ${S.gate} + ${S.dt} · Missing from ${S.odoo}`,
  "DT Missing — Ops & Odoo Agree": `Seen by ${S.sheet} + ${S.odoo} · Missing from ${S.dt}`,
  "Ops Sheet Missing — DT & Odoo Agree": `Seen by ${S.dt} + ${S.odoo} · Missing from ${S.sheet}`,
  "Sheet-Only Dispatch — No Trail": `Seen by ${S.sheet} only · No other record`,
  "DT-Only — Fake Scan Risk": `Seen by ${S.dt} only · No other record`,
  "Duplicate Scan / Multi-Source Mismatch": "Duplicate scan · Same barcode twice",
};

/**
 * The phrase for a stored variance name, or null when there is none.
 *
 * Null rather than the raw name: a caller showing the short name above this
 * would otherwise repeat a sentence nobody wrote for that row, and a silent
 * blank is the honest answer for a name this file has not been taught.
 */
export const variancePhrase = (name: string | null | undefined): string | null =>
  // `(name && PHRASE[name]) ?? null` looks equivalent and is not: an empty name
  // short-circuits to "" and `??` passes it straight through, so the caller
  // renders an empty second line instead of none.
  name ? PHRASE[name] ?? null : null;

/** Every stored name this module knows — used by the test that keeps it whole. */
export const phrasedNames = (): string[] => Object.keys(PHRASE);
