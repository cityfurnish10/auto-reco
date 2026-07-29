// The follow-up's subject line.
//
// A visibly different prefix from the digest's on purpose: too similar and mail
// clients thread the two, hiding the follow-up under the original.

import { fmtDateShort } from "../digest/sections";
import type { FollowUpComparison } from "./compare";

export function followUpSubject(c: FollowUpComparison): string {
  const d = fmtDateShort(c.date);
  // The number sits inside the first ~40 characters, where Gmail on a phone
  // truncates.
  if (c.moreThanReported) {
    return `Follow-up: ${d} stock check — ${c.stillOpen} still open, ${c.flagged} first reported`;
  }
  if (c.stillOpen === 0) {
    return `Follow-up: ${d} stock check — all ${c.flagged} items closed`;
  }
  return `Follow-up: ${d} stock check — ${c.stillOpen} of ${c.flagged} items still open`;
}
