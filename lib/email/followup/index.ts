// Public surface of the follow-up email.
//
// It reuses the digest's section model and BOTH renderers rather than growing a
// parallel pair — that separation is the whole reason the HTML and plaintext
// bodies can no longer drift apart. What it does not reuse is the digest's
// sections.ts: a separate builder keeps the digest's word budget, anti-drift
// test and model snapshot untouched.

import { renderHtml } from "../digest/render-html";
import { renderText } from "../digest/render-text";
import { buildFollowUpSections, FOLLOW_UP_KICKER, type FollowUpOpts } from "./sections";
import type { FollowUpComparison } from "./compare";

export { buildFollowUpSections, FOLLOW_UP_KICKER, FOLLOW_UP_WORD_BUDGET } from "./sections";
export { followUpSubject } from "./subject";
export { compareToSnapshot, isStillOpen } from "./compare";
export type { FollowUpComparison, CurrentRow } from "./compare";
export type { FollowUpOpts } from "./sections";

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function dateLabel(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  return y && m && day ? `${day} ${MONTHS[m - 1]} ${y}` : d;
}

export function renderFollowUpHtml(c: FollowUpComparison, opts: FollowUpOpts = {}): string {
  const label = dateLabel(c.date);
  return renderHtml(buildFollowUpSections(c, label, opts), label, FOLLOW_UP_KICKER);
}

export function renderFollowUpText(c: FollowUpComparison, opts: FollowUpOpts = {}): string {
  const label = dateLabel(c.date);
  return renderText(buildFollowUpSections(c, label, opts), label, FOLLOW_UP_KICKER);
}
