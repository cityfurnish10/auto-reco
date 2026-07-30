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
  // "Reading failed" reads as if the guard failed. It was our scanner, and
  // the owner does not need to know which.
  failed: "Unreadable",
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

function openingLine(d: DigestData, registerShort: boolean): string {
  const { tier1, tier2, movements } = d.totals;
  // "closed at 3pm" is load-bearing: the digest goes out at 16:45 IST, an hour
  // after the business day shut. The year is dropped — it is in the masthead —
  // and so is "today", which a deferred send turns into a lie.
  const head = `${fmtDate(d.date)} closed at 3pm.`;
  const moved = movements > 0 ? n(movements) : null;

  if (tier1 === 0 && tier2 === 0) {
    // "All accounted for" is BLOCKED while any live city is short a book —
    // the same rule subject.ts already applies, for the same reason: the clean
    // headline would be a lie, and the caveat three lines below would contradict
    // it in the same email.
    if (registerShort) {
      return moved
        ? `${head} ${moved} units moved and nothing has been flagged so far — but not every record has arrived yet.`
        : `${head} Nothing has been flagged so far — but not every record has arrived yet.`;
    }
    const all = moved ? `All ${moved} units that moved are accounted for.` : "Every unit that moved is accounted for.";
    // Only claimed from 3 days up: "two clean days running" is a coincidence.
    return (d.cleanStreak ?? 0) >= 3
      ? `${head} ${all.slice(0, -1)} — ${n(d.cleanStreak!)} clean days running.`
      : `${head} ${all}`;
  }
  if (tier1 === 0) {
    if (registerShort) {
      return `${head} ${moved ? `${moved} units moved. ` : ""}Nothing is unaccounted for so far, though not every record has arrived. ${n(tier2)} are written up wrong and need correcting.`;
    }
    const all = moved ? `All ${moved} units that moved are accounted for.` : "Every unit that moved is accounted for.";
    return `${head} ${all} ${n(tier2)} of them are written up wrong and need correcting.`;
  }

  // THE LEAD: rate first, so the reader knows in one clause whether today is
  // unusual. "we cannot place" is the tier-1 rule in the owner's own words, and
  // a plainer claim than "moved without a full trail".
  const rate = movements > 0 ? Math.round(movements / tier1) : null;
  const head2 = moved
    ? `${moved} units moved and we cannot place ${n(tier1)} of them`
    : `We cannot place ${n(tier1)} ${tier1 === 1 ? "unit" : "units"}`;

  // The rate clause is suppressed whenever any live city was short a book: a day
  // we could not fully see must not be ranked against days we could.
  const verdict = d.dayTrend === "worst" ? ", the worst rate this week"
    : d.dayTrend === "best" ? ", the best rate this week"
    : d.dayTrend === "usual" ? ", in line with the week"
    : "";
  const lead = rate && verdict ? `${head2} — 1 in ${n(rate)}${verdict}.` : `${head2}.`;

  const rest = tier2 > 0 ? ` Another ${n(tier2)} are on the floor but written up wrong.` : "";
  return `${head} ${lead}${rest}`;
}

const TREND_TEXT = { worse: "Worse", usual: "Usual", better: "Better" } as const;

function citySnapshot(cities: CityDigestRow[], footnote: string | null): Block {
  const rows = cities.map((c) => [
    { text: cityName(c.city) },
    { text: n(c.movements), align: "right" as const },
    { text: n(c.tier1), align: "right" as const, tone: c.tier1 > 0 ? ("danger" as const) : undefined, strong: c.tier1 > 0 },
    {
      // An em dash means "not comparable", NEVER "no change" — the city was
      // short a book, or has too little history. Rendering it as "Usual" would
      // turn an outage into reassurance.
      text: c.trend ? TREND_TEXT[c.trend] : "—",
      tone: c.trend === "worse" ? ("danger" as const)
        : c.trend === "better" ? ("good" as const)
        : ("muted" as const),
    },
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
      { label: "vs last week" },
      { label: "Guard register" },
    ],
    rows,
    // The caveat sits UNDER the rows it qualifies, not sixty words below in a
    // footer. The slot already existed in the model and in both renderers and
    // had never been used.
    ...(footnote ? { footnote } : {}),
  };
}

function actionList(actions: ActionItem[], limit: number): Block[] {
  const shown = actions.slice(0, limit);
  const hidden = actions.length - shown.length;
  const blocks: Block[] = [
    {
      kind: "list",
      items: shown.map((a, i) => ({
        // ONE risk sentence, on the largest tier-1 job. It is the only place in
        // the email where a label gets defined, and it is the sentence that makes
        // an owner walk to the gate rather than forward the mail. Three would
        // cost a quarter of the budget to justify work that gets delegated
        // anyway; zero is what shipped, on the false premise that the dashboard
        // was showing it.
        text: i === 0 && a.tier === 1 && a.risk
          ? `${a.label} — ${n(a.count)} ${a.count === 1 ? "unit" : "units"} (${cityBreakdown(a)}). ${a.risk} ${a.action}`
          : `${a.label} — ${n(a.count)} ${a.count === 1 ? "unit" : "units"} (${cityBreakdown(a)}). ${a.action}`,
        sub: a.team,
        tone: a.tier === 1 ? "danger" : "warn",
      })),
    },
  ];
  if (hidden > 0) {
    // "jobs", not "kinds of item": after the regrouping fix each line IS one job
    // — one problem with one fix and one owner.
    blocks.push({
      kind: "para",
      text: `+${hidden} more ${hidden === 1 ? "job" : "jobs"}, all on the dashboard.`,
      tone: "muted",
    });
  }
  return blocks;
}

function watchLines(d: DigestData): string[] {
  if (!d.watch?.length) return [];
  return d.watch.map((w) => {
    const where = `${w.label}, ${cityName(w.city)}`;
    if (w.trend === "cleared")
      return `${where} — clear today after ${w.days} straight days.`;
    if (w.trend === "worsening")
      // Both numbers are LABELLED. "40 to 61 units" never said which end was
      // today, so the reader had to guess which direction it was moving.
      return `${where} — ${w.days} of the last 7 days, and getting worse: ${n(w.median)} usually, ${n(w.today)} today.`;
    return `${where} — ${n(w.today)} again today, the ${w.days}${ordinal(w.days)} day running.`;
  });
}

/** 1st, 2nd, 3rd, 4th — English, not a number followed by "th". */
function ordinal(x: number): string {
  const rem100 = x % 100;
  if (rem100 >= 11 && rem100 <= 13) return "th";
  return ["th", "st", "nd", "rd"][x % 10] ?? "th";
}

function informationalLine(d: DigestData): string | null {
  // The tier-3 TOTAL, not the top three kinds. "123 odoo posting delay" is a
  // count followed by a lower-cased singular proper noun — not English, and the
  // labels have no plural form to fix it with. Using the full total is also what
  // makes the arithmetic close: tier1 + tier2 + this = the number on the button.
  const { tier3 } = d.totals;
  if (tier3 === 0) return null;
  return `The other ${n(tier3)} items open today need nothing from anyone.`;
}

/**
 * Cities reconciled without their guard register ran on three sources, not
 * four, so their at-risk count is UNDERSTATED. Saying so is not optional.
 */
function threeSourceCaveat(d: DigestData): string | null {
  const short = d.cities.filter((c) => c.register === "missing" || c.register === "failed");
  if (short.length === 0) return null;
  const named = short.map((c) => cityName(c.city));
  const names = named.length > 1
    ? `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`
    : named[0];
  // State the EFFECT, but do NOT claim a direction.
  //
  // "too low" was wrong in both directions. Missing the register HIDES items
  // only it could raise (rung 4, "Off-System Movement" — a unit only the guard
  // saw leave never enters the universe at all), and it PROMOTES others that the
  // register's presence would have demoted (rung 8 fires DT-only as tier 1).
  // The count is unreliable, not understated, and saying which way it leans
  // would be a guess dressed as a finding.
  return short.length === 1
    ? `${names} was checked against three records, not four, so its at-risk number is not comparable with the rest.`
    : `${names} were checked against three records, not four, so their at-risk numbers are not comparable with the rest.`;
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
 * Words the renderers add outside the section model. Reserved here so the trim
 * measures what a recipient actually receives; without it the ladder stops one
 * section too late and the budget is quietly exceeded.
 *
 * MEASURED, not guessed, on a rendered rich day: masthead 9 + footer 13 + one
 * table rule row (1 token per column, 5) + one "- " per list item (5) + the CTA
 * URL (1) = 33. The reserve was 30, so the ladder believed it had three words it
 * did not have — and a model that passed the gate could render at 251 and fail
 * the budget test.
 *
 * 36, not 33, because the list-item and column terms GROW with the content: a
 * fixed reserve has to cover the worst shape, not the measured one.
 */
const BOILERPLATE_WORDS = 36;

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
    // One paragraph. The reconciling line that used to sit here spent 20 words —
    // a tenth of the whole budget — explaining why two of our own screens count
    // differently. The tier-3 total in the footer now closes the arithmetic
    // without teaching anyone the word "tier", and those 20 words paid for the
    // risk sentence in the action list.
    sections.push({
      id: "opening",
      blocks: [{ kind: "para", text: openingLine(data, threeSourceCaveat(data) !== null) }],
    });
  }

  if (data.cities.length > 0) {
    sections.push({
      id: "cities",
      title: "By city",
      blocks: [citySnapshot(data.cities, threeSourceCaveat(data))],
    });
  }

  if (data.actions.length > 0) {
    sections.push({
      id: "actions",
      title: "Do this today",
      // FOUR, not five. The risk sentence on the top job is worth ~18 words, and
      // with five actions the rich day rendered at 248 of 250 -- inside the
      // budget but with no room for a future word. Four lands at ~233, and the
      // "+N more jobs" pointer already carries the remainder. The trim ladder
      // still protects the top three below this.
      blocks: actionList(data.actions, 4),
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
      blocks: [
        {
          kind: "cta",
          // The button carries the total, which is what lets the reconciling
          // line go: tier1 + tier2 + the footer's tier-3 count adds up to this
          // number, without anyone being taught the word "tier".
          label: data.totals.open > 0
            ? `Open all ${n(data.totals.open)} items on the dashboard`
            : "See the day, city by city",
          href: opts.dashboardUrl,
        },
      ],
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
