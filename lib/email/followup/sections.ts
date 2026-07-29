// Every user-visible string in the follow-up email.
//
// The renderers in lib/email/digest/ emit structure only; nothing below them
// contains a word. This file is the whole vocabulary of the follow-up, and it
// is a separate builder from the digest's so the digest's word budget,
// anti-drift test and model snapshot are untouched.

import { TIER } from "../../ui/variance-labels";
import type { Block, Section } from "../digest/model";
import type { FollowUpComparison } from "./compare";

/** Masthead line. Deliberately not "Daily stock check". */
export const FOLLOW_UP_KICKER = "Stock check follow-up";

/**
 * Word ceiling for the rendered text.
 *
 * Lower than the digest's because every section here is fixed-size: the city
 * table is capped at five rows by the city CHECK constraint, and there is no
 * unbounded action list. Asserted by test rather than trimmed at runtime — if
 * this is ever exceeded, something new was added and should be argued for.
 */
export const FOLLOW_UP_WORD_BUDGET = 200;

export interface FollowUpOpts {
  dashboardUrl?: string;
  /** Set when the re-check never completed and the figures may be stale. */
  staleSince?: string | null;
  /** Cities whose warehouse was shut on the reported date. */
  restDayCities?: string[];
}

const n = (v: number) => v.toLocaleString("en-IN");

/**
 * A timestamp as a person would say it, in IST.
 *
 * The raw ISO string leaked into a draft of this email; "2026-07-26T11:02:00Z"
 * in a message to a warehouse owner is an implementation detail escaping.
 */
function fmtWhen(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "earlier";
  const d = new Date(t + 5.5 * 60 * 60 * 1000);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} at ${hh}:${mm}`;
}

const cityName = (c: string) => c.charAt(0) + c.slice(1).toLowerCase();

function openingLines(c: FollowUpComparison, dateLabel: string): Block[] {
  const blocks: Block[] = [];

  if (c.moreThanReported) {
    // No closed count: it would be negative. Say why instead of clamping.
    blocks.push({
      kind: "para",
      text: `The ${dateLabel} report flagged ${n(c.flagged)} items. ${n(
        c.stillOpen
      )} are still open — more than the report showed.`,
    });
    blocks.push({
      kind: "para",
      tone: "muted",
      text: "An item settled on the day can be reopened later, so this count can rise.",
    });
  } else if (c.stillOpen === 0) {
    blocks.push({
      kind: "para",
      tone: "good",
      text: `The ${dateLabel} report flagged ${n(c.flagged)} items. All ${n(
        c.flagged
      )} are now closed.`,
    });
  } else {
    blocks.push({
      kind: "para",
      text: `The ${dateLabel} report flagged ${n(c.flagged)} items. ${n(
        c.stillOpen
      )} ${c.stillOpen === 1 ? "is" : "are"} still open; ${n(c.closed)} ${
        c.closed === 1 ? "has" : "have"
      } been closed.`,
    });
  }

  if (c.stillOpen > 0) {
    const t1 = TIER[1].heading.toLowerCase();
    const t2 = TIER[2].heading.toLowerCase();
    if (c.stillOpenTier1 === 0) {
      blocks.push({ kind: "para", text: `None of the ${n(c.stillOpen)} still open are ${t1}.` });
    } else if (c.stillOpenTier2 === 0) {
      blocks.push({ kind: "para", text: `All ${n(c.stillOpen)} still open are ${t1}.` });
    } else {
      blocks.push({
        kind: "para",
        text: `Of the ${n(c.stillOpen)} still open, ${n(c.stillOpenTier1)} are ${t1} and ${n(
          c.stillOpenTier2
        )} are ${t2}.`,
      });
    }
  }

  return blocks;
}

export function buildFollowUpSections(
  c: FollowUpComparison,
  dateLabel: string,
  opts: FollowUpOpts = {}
): Section[] {
  const sections: Section[] = [];

  // A stale-figures banner outranks everything: if the re-check never ran, the
  // numbers below describe an older moment and the reader must know first.
  if (opts.staleSince) {
    sections.push({
      id: "stale",
      blocks: [
        {
          kind: "callout",
          tone: "warn",
          title: "These figures may be out of date",
          lines: [
            `${dateLabel} could not be re-checked before this went out. The counts below are as of the last completed check, ${fmtWhen(
              opts.staleSince
            )}.`,
          ],
        },
      ],
    });
  }

  sections.push({ id: "opening", blocks: openingLines(c, dateLabel) });

  const showNew = c.newlyFlagged > 0 && !c.newlyFlaggedUnknown;
  const columns = [
    { label: "City" },
    { label: "Flagged", align: "right" as const },
    { label: "Still open", align: "right" as const },
    { label: "Closed", align: "right" as const },
    ...(showNew ? [{ label: "New", align: "right" as const }] : []),
  ];

  sections.push({
    id: "cities",
    title: "By city",
    blocks: [
      {
        kind: "table",
        columns,
        rows: c.cities.map((row) => [
          { text: cityName(row.city) },
          { text: n(row.flagged), align: "right" as const },
          {
            text: n(row.stillOpen),
            align: "right" as const,
            tone: row.stillOpen > 0 ? ("danger" as const) : ("muted" as const),
          },
          { text: n(row.closed), align: "right" as const },
          ...(showNew ? [{ text: n(row.newlyFlagged), align: "right" as const }] : []),
        ]),
      },
    ],
  });

  const what: Block[] = [
    {
      kind: "para",
      tone: "muted",
      text: "Closed means someone settled the item on the dashboard, or a later entry filled the gap on its own.",
    },
  ];

  if (showNew) {
    what.push({
      kind: "para",
      tone: "warn",
      text: `${n(c.newlyFlagged)} further items have been flagged for ${dateLabel} since the report went out, as later entries arrived. They are not counted above.`,
    });
  }

  if (opts.restDayCities?.length) {
    // Their floor sources were legitimately absent, so nothing could clear
    // itself there. A flat number would read as "nothing got fixed".
    const names = opts.restDayCities.map(cityName).join(", ");
    what.push({
      kind: "para",
      tone: "muted",
      text: `${names} were closed that day, so their items could not be re-checked against the floor.`,
    });
  }

  what.push({
    kind: "para",
    text:
      c.stillOpen === 0
        ? `Nothing from ${dateLabel} is left to chase.`
        : `Anything still open has been outstanding since ${dateLabel} — close it on the dashboard, or record why it cannot be closed.`,
    tone: c.stillOpen === 0 ? "good" : "normal",
  });

  sections.push({ id: "what", blocks: what });

  if (opts.dashboardUrl) {
    sections.push({
      id: "link",
      blocks: [
        {
          kind: "cta",
          label: c.stillOpen === 0 ? "See the day on the dashboard" : "See what is still open",
          href: opts.dashboardUrl,
        },
      ],
    });
  }

  return sections;
}
