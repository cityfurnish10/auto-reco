// EVERY user-visible string in the digest lives in this file.
//
// The renderers emit structure only — tags, padding, bullets, rules. If you are
// about to type a word a recipient will read, it belongs here. That rule is what
// keeps the HTML and plaintext bodies saying the same thing; they previously
// drifted far enough that the plaintext reader got no dashboard link at all.
//
// Audience: the owner, who wants one question answered — can we still account
// for every unit that moved? Everything is written to that. Budget is 250 words
// of rendered text, enforced by a test, with a deterministic degradation ladder
// (see trimToBudget) so a busy day drops the least important section rather than
// truncating mid-sentence.

import type { Block, Section } from "./model";
import type { ActionItem, CityDigestRow, DigestData, RegisterState } from "./types";

/** Cities are stored upper-case; humans read title case. */
function cityName(city: string): string {
  return city.charAt(0) + city.slice(1).toLowerCase();
}

function fmtDate(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  if (!y || !m || !day) return d;
  return `${day} ${months[m - 1]} ${y}`;
}

export function fmtDateShort(d: string): string {
  const [, m, day] = d.split("-").map(Number);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  if (!m || !day) return d;
  return `${day} ${months[m - 1]}`;
}

const REGISTER_TEXT: Record<RegisterState, string> = {
  received: "Received",
  // Three different asks of three different people, so three different words.
  missing: "Not received",
  pending: "Not read yet",
  failed: "Reading failed",
  off: "Weekly off",
};

const n = (x: number) => x.toLocaleString("en-IN");

/** "Delhi 31, Bangalore 25" — or "+3 cities" once the list stops being useful. */
function cityBreakdown(item: ActionItem): string {
  const named = item.cities.slice(0, 2);
  const rest = item.cities.length - named.length;
  const parts = named.map((c) => `${cityName(c.city)} ${c.count}`);
  if (rest > 0) parts.push(`+${rest} ${rest === 1 ? "city" : "cities"}`);
  return parts.join(", ");
}

function openingLine(d: DigestData): string {
  const { tier1, tier2 } = d.totals;
  // "closed at 3pm today" is load-bearing: the digest goes out at 16:45 IST,
  // an hour after the business day shut, so "today" is literally actionable —
  // and it pre-empts "why am I reading about yesterday".
  const head = `${fmtDate(d.date)} closed at 3pm today.`;
  if (tier1 === 0 && tier2 === 0) {
    return `${head} Every unit that moved can be traced.`;
  }
  if (tier1 === 0) {
    return `${head} Every unit that moved can be traced. ${n(tier2)} records still need fixing.`;
  }
  return `${head} ${n(tier1)} ${tier1 === 1 ? "unit" : "units"} moved without a full trail — those could mean missing stock. ${n(tier2)} more need a record fixed.`;
}

/**
 * The email counts by risk, the dashboard counts every open item. Those numbers
 * differ for the same run and the same day, so say why rather than leaving the
 * reader to notice.
 */
function reconcilingLine(d: DigestData): string | null {
  const { open, tier1, tier2, tier3 } = d.totals;
  if (open === 0 || open === tier1) return null;
  return `${n(open)} open in total on the dashboard: ${n(tier1)} need a decision today, ${n(tier2)} are records to correct, ${n(tier3)} need nothing.`;
}

function citySnapshot(cities: CityDigestRow[]): Block {
  const rows = cities.map((c) => [
    { text: cityName(c.city) },
    { text: n(c.movements), align: "right" as const },
    { text: n(c.tier1), align: "right" as const, tone: c.tier1 > 0 ? ("danger" as const) : undefined, strong: c.tier1 > 0 },
    { text: n(c.tier2), align: "right" as const, tone: c.tier2 > 0 ? ("warn" as const) : undefined },
    {
      text: REGISTER_TEXT[c.register],
      tone: c.register === "missing" || c.register === "failed" ? ("danger" as const)
        : c.register === "pending" ? ("warn" as const)
        : ("muted" as const),
    },
  ]);
  return {
    kind: "table",
    columns: [
      { label: "City" },
      { label: "Units moved", align: "right" },
      { label: "At risk", align: "right" },
      { label: "To fix", align: "right" },
      { label: "Guard register" },
    ],
    rows,
  };
}

function actionList(actions: ActionItem[], limit: number): Block[] {
  const shown = actions.slice(0, limit);
  const hidden = actions.length - shown.length;
  const blocks: Block[] = [
    {
      kind: "list",
      items: shown.map((a) => ({
        // The ACTION, not the risk sentence. The risk copy ships in the label
        // module and renders on the dashboard; carrying it here would cost
        // roughly a third of the word budget to say what the label implies.
        text: `${a.label} — ${n(a.count)} ${a.count === 1 ? "unit" : "units"} (${cityBreakdown(a)}). ${a.action}`,
        sub: a.team,
        tone: a.tier === 1 ? "danger" : "warn",
      })),
    },
  ];
  if (hidden > 0) {
    blocks.push({
      kind: "para",
      text: `+${hidden} more ${hidden === 1 ? "kind" : "kinds"} of item — see the dashboard.`,
      tone: "muted",
    });
  }
  return blocks;
}

function watchLines(d: DigestData): string[] {
  if (!d.watch?.length) return [];
  return d.watch.map((w) => {
    const where = `${w.label}, ${cityName(w.city)}`;
    if (w.trend === "cleared") return `${where} — cleared after ${w.days} days.`;
    if (w.trend === "worsening")
      return `${where} — ${w.days} of the last 7 days, ${n(w.median)} to ${n(w.today)} units.`;
    return `${where} — ${w.days} days running at about ${n(w.today)} units.`;
  });
}

function informationalLine(d: DigestData): string | null {
  const top = d.informational.slice(0, 3);
  if (top.length === 0) return null;
  const parts = top.map((i) => `${n(i.count)} ${i.label.toLowerCase()}`);
  return `Also logged, no action needed: ${parts.join(", ")}.`;
}

/**
 * Cities reconciled without their guard register ran on three sources, not
 * four, so their at-risk count is UNDERSTATED. Saying so is not optional.
 */
function threeSourceCaveat(d: DigestData): string | null {
  const short = d.cities.filter((c) => c.register === "missing" || c.register === "failed");
  if (short.length === 0) return null;
  const names = short.map((c) => cityName(c.city)).join(", ");
  const verb = short.length === 1 ? "did not arrive, so its numbers come" : "did not arrive, so their numbers come";
  return `${names}: the guard register ${verb} from three records, not four.`;
}

export interface SectionOpts {
  dashboardUrl?: string;
  notes?: string;
  attachmentNote?: string;
  /** Set false in tests to inspect the untrimmed model. */
  trim?: boolean;
}

/** Rendered-word budget for the whole email. A test asserts the worst case. */
// The masthead line. A parameter rather than a default, so the follow-up must
// name its own and cannot silently inherit "Daily stock check".
export const DIGEST_KICKER = "Daily stock check";

export const WORD_BUDGET = 250;

/**
 * Words the renderers add outside the section model — the masthead line and
 * the footer sentence. Reserved here so the trim measures what a recipient
 * actually receives; without it the ladder stops one section too late and the
 * budget is quietly exceeded.
 */
const BOILERPLATE_WORDS = 30;

export function buildSections(data: DigestData, opts: SectionOpts = {}): Section[] {
  const sections: Section[] = [];

  if (opts.notes) {
    sections.push({
      id: "note",
      blocks: [{ kind: "callout", tone: "note", title: "Note from the admin", lines: [opts.notes] }],
    });
  }

  // If the check did not finish, every number below is stale or absent. That
  // outranks everything else and replaces the opening line rather than sitting
  // above it — and the watch list is dropped to pay for the words.
  if (data.runIncomplete) {
    sections.push({
      id: "incomplete",
      blocks: [
        {
          kind: "callout",
          tone: "danger",
          title: "The stock check did not finish",
          lines: [
            `The ${fmtDate(data.date)} check did not complete, so the figures below may be out of date or missing. Check the dashboard before acting on them.`,
          ],
        },
      ],
    });
  } else {
    const blocks: Block[] = [{ kind: "para", text: openingLine(data) }];
    const rec = reconcilingLine(data);
    if (rec) blocks.push({ kind: "para", text: rec, tone: "muted" });
    sections.push({ id: "opening", blocks });
  }

  if (data.cities.length > 0) {
    sections.push({ id: "cities", title: "By city", blocks: [citySnapshot(data.cities)] });
  }

  if (data.actions.length > 0) {
    sections.push({
      id: "actions",
      title: "Do this today",
      blocks: actionList(data.actions, 5),
    });
  }

  const watch = watchLines(data);
  if (watch.length > 0 && !data.runIncomplete) {
    sections.push({
      id: "watch",
      title: "Worth watching",
      blocks: [{ kind: "list", items: watch.map((text) => ({ text, tone: "muted" as const })) }],
    });
  }

  const footer: Block[] = [];
  const info = informationalLine(data);
  if (info) footer.push({ kind: "para", text: info, tone: "muted" });
  const caveat = threeSourceCaveat(data);
  if (caveat) footer.push({ kind: "para", text: caveat, tone: "warn" });
  if (opts.attachmentNote) {
    footer.push({
      kind: "para",
      text: `No city registers attached — ${opts.attachmentNote}.`,
      tone: "muted",
    });
  }
  if (footer.length > 0) sections.push({ id: "footer", blocks: footer });

  if (opts.dashboardUrl) {
    sections.push({
      id: "link",
      blocks: [{ kind: "cta", label: "See every unit, city by city", href: opts.dashboardUrl }],
    });
  }

  return opts.trim === false ? sections : trimToBudget(sections);
}

/**
 * Deterministic degradation, applied here rather than by hand at write time.
 *
 * Order: the watch list goes first, then the action list shrinks, then the
 * informational breakdown. NEVER dropped: the opening line, the at-risk column,
 * the top three actions, the link, and the incomplete-run banner.
 */
export function trimToBudget(sections: Section[]): Section[] {
  const words = (s: Section[]) =>
    s.flatMap((sec) => [
      ...(sec.title ? [sec.title] : []),
      ...sec.blocks.flatMap(blockText),
    ]).join(" ").trim().split(/\s+/).filter(Boolean).length;

  const budget = WORD_BUDGET - BOILERPLATE_WORDS;

  let out = sections;
  if (words(out) <= budget) return out;

  // 1. Watch list: one line, then none.
  out = out.map((s) =>
    s.id === "watch" && s.blocks[0]?.kind === "list"
      ? { ...s, blocks: [{ ...s.blocks[0], items: s.blocks[0].items.slice(0, 1) }] }
      : s
  );
  if (words(out) <= budget) return out;
  out = out.filter((s) => s.id !== "watch");
  if (words(out) <= budget) return out;

  // 2. Actions: five to three, keeping the "+N more" pointer honest.
  out = out.map((s) => {
    if (s.id !== "actions") return s;
    const list = s.blocks.find((b) => b.kind === "list");
    if (list?.kind !== "list" || list.items.length <= 3) return s;
    // The section may ALREADY carry a "+N more" line from the initial 5-cap.
    // Those N are still hidden, so they must be added rather than replaced —
    // otherwise the email under-reports what it is not showing.
    const existing = s.blocks.find(
      (b): b is Extract<Block, { kind: "para" }> => b.kind === "para" && /^\+\d+ more/.test(b.text)
    );
    const alreadyHidden = existing ? Number(/^\+(\d+)/.exec(existing.text)?.[1] ?? 0) : 0;
    const dropped = list.items.length - 3 + alreadyHidden;
    return {
      ...s,
      blocks: [
        { ...list, items: list.items.slice(0, 3) },
        {
          kind: "para",
          text: `+${dropped} more ${dropped === 1 ? "kind" : "kinds"} of item — see the dashboard.`,
          tone: "muted",
        },
      ],
    };
  });
  if (words(out) <= budget) return out;

  // 3. Informational breakdown collapses to a bare count.
  out = out.map((s) => {
    if (s.id !== "footer") return s;
    return {
      ...s,
      blocks: s.blocks.map((b) =>
        b.kind === "para" && b.text.startsWith("Also logged")
          ? { kind: "para" as const, text: "Other items were logged with no action needed.", tone: "muted" as const }
          : b
      ),
    };
  });
  return out;
}

function blockText(b: Block): string[] {
  switch (b.kind) {
    case "para":
      return [b.text];
    case "callout":
      return [b.title, ...b.lines];
    case "table":
      return [
        ...b.columns.map((c) => c.label),
        ...b.rows.flatMap((r) => r.map((c) => c.text)),
        ...(b.footnote ? [b.footnote] : []),
      ];
    case "list":
      return b.items.flatMap((i) => (i.sub ? [i.text, i.sub] : [i.text]));
    case "cta":
      return [b.label];
    default: {
      const never: never = b;
      throw new Error(`blockText: unhandled ${JSON.stringify(never)}`);
    }
  }
}
