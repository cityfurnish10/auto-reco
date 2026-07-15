// Best-effort guess at a page's direction from its header text (the register
// PDF has IN and OUT segregated by page, per page — e.g. a page titled
// "OUTWARD REGISTER"). Returns null on anything ambiguous rather than
// guessing — the reviewer always sees and can override this in review-grid.tsx,
// so a wrong guess is a one-click fix, but a WRONG SILENT guess would feed a
// mislabeled direction straight into the engine.

import type { OcrLine } from "./azure-vision";
import type { Direction } from "../../engine/types";

const OUT_KEYWORDS = ["outward", "out ward", "dispatch", "delivery", " out"];
const IN_KEYWORDS = ["inward", "in ward", "return", "pickup", "receipt", " in"];

export function detectPageDirection(lines: OcrLine[]): Direction | null {
  // Only look at the first few lines — the direction marker is expected to be
  // in the page title/header, not buried in the body.
  const headerText = lines
    .slice(0, 5)
    .map((l) => ` ${l.text.toLowerCase()} `)
    .join(" ");

  const hasOut = OUT_KEYWORDS.some((kw) => headerText.includes(kw));
  const hasIn = IN_KEYWORDS.some((kw) => headerText.includes(kw));

  if (hasOut && !hasIn) return "OUT";
  if (hasIn && !hasOut) return "IN";
  return null; // ambiguous or no match — force an explicit reviewer choice
}
