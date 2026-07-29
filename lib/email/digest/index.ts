// Public surface of the digest. Signatures are unchanged from the old
// single-file lib/email/digest.ts, so every import site resolves here with no
// edit: lib/email/index.ts, the preview route, the archive route.

import { buildSections, DIGEST_KICKER, type SectionOpts } from "./sections";
import { renderHtml } from "./render-html";
import { renderText } from "./render-text";
import type { DigestData } from "./types";

export { buildDigestFromDb } from "./build";
export { digestSubject } from "./subject";
export { buildSections, WORD_BUDGET, DIGEST_KICKER } from "./sections";
export { visibleStrings } from "./model";
export type { DigestData, CityDigestRow, CityMovementCounts, ActionItem, WatchItem, RegisterState } from "./types";
export type { Section, Block } from "./model";

function dateLabel(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return y && m && day ? `${day} ${months[m - 1]} ${y}` : d;
}

export function renderDigestHtml(
  data: DigestData,
  dashboardUrl?: string,
  notes?: string,
  attachmentNote?: string
): string {
  const opts: SectionOpts = { dashboardUrl, notes, attachmentNote };
  return renderHtml(buildSections(data, opts), dateLabel(data.date), DIGEST_KICKER);
}

// Takes dashboardUrl for the same reason the HTML renderer does. The old
// plaintext renderer had no link parameter at all, so a text-only reader could
// not reach the dashboard — the drift this whole restructure exists to stop.
export function renderDigestText(
  data: DigestData,
  dashboardUrl?: string,
  notes?: string,
  attachmentNote?: string
): string {
  const opts: SectionOpts = { dashboardUrl, notes, attachmentNote };
  return renderText(buildSections(data, opts), dateLabel(data.date), DIGEST_KICKER);
}
