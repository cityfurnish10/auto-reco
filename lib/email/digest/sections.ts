// EVERY user-visible string in the digest lives in this file.
//
// The renderers emit structure only — tags, padding, bullets, rules. If you are
// about to type a word a recipient will read, it belongs here. That rule is what
// keeps the HTML and plaintext bodies saying the same thing; they previously
// drifted far enough that the plaintext reader got no dashboard link at all.
//
// Audience: the owner, who wants one question answered — can we still account
// for every unit that moved? Everything is written to that. Budget is 550 words
// of rendered text, enforced by a test, with a deterministic degradation ladder
// (see trimToBudget) so a busy day drops the least important section rather than
// truncating mid-sentence.
//
// THREE PARTS, in the order the founder asked for them:
//   1 · Four-way check          did all four records agree, per city, drawn
//   2 · At risk                 what is actually missing, and who fixes it
//   3 · Open more than two days what we still have not dealt with
// Part 3 replaced a separate follow-up email that used to go out three days
// after each digest; a second mail nobody had asked for was worse at the job
// than a section in the one they already open.

import type { BarRow, Block, Heat, Section } from "./model";
import { renderText } from "./render-text";
import type { ActionItem, CityDigestRow, DigestData, RegisterState } from "./types";
import { directionSkew, fullyReported, SOURCE_NAME, topMissing, type SourceKey } from "./coverage";
import { closedPartOfWindow, isCityOff } from "../../engine/schedule";
import type { City } from "../../sample-data";
import { LOOKBACK_DAYS } from "./ageing";

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

/** "Mumbai, Pune and Hyderabad" — never a bare comma list. */
function andList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// ─── part one: the four-way check ────────────────────────────────────────────

/**
 * The 4/3/2/1 split per city, drawn.
 *
 * Deliberately NOT a pass rate. Measured 2026-07-29, the first date with all
 * four sources live: Delhi reached all four on 23 of 150 units, Bangalore 39 of
 * 131 — while the engine put NINE units of 503 at risk that day. "15% passed"
 * and "98% fine" describe the same day, and only the second is true in the sense
 * a reader will take. So the chart shows the DISTRIBUTION, never a rate, and the
 * key names each band. The explanatory legend that used to sit underneath was
 * cut at the owner's request; the per-city badges now carry the reason a green
 * column is missing.
 */
function coverageSection(data: DigestData): Section | null {
  const cov = data.coverage;
  if (!cov || cov.cities.length === 0) return null;

  const rows: BarRow[] = [];
  let scored = 0;

  // Cities that CAN be scored first, biggest first; the ones that cannot sink to
  // the bottom. The reader came for the bars, and sorting purely by size floats
  // a city with no bar at all to the top of the section — measured: Mumbai, shut
  // for its weekly off, led a list whose next two rows were the only real data.
  const ordered = [...cov.cities].sort((a, b) => {
    const sa = fullyReported(a) && !isCityOff(a.city as City, cov.date) ? 1 : 0;
    const sb = fullyReported(b) && !isCityOff(b.city as City, cov.date) ? 1 : 0;
    return sb - sa || b.total - a.total || a.city.localeCompare(b.city);
  });

  // Cities that could not reach all four. Only the return guard reads this now
  // — the explanatory legend it used to feed was cut from the email.
  const noGreen: string[] = [];

  for (const c of ordered) {
    const off = isCityOff(c.city as City, cov.date);
    // A business day runs 3pm to 3pm, so a one-day closure lands inside TWO
    // business dates and a city can be shut for HALF the window while still
    // moving stock in the other half. Part 2's table already marks those
    // "(week off)"; without the same test here the same city is charted as a
    // working warehouse that lost its register, and one email describes it two
    // different ways.
    const partly = closedPartOfWindow(c.city as City, cov.date);
    if (off) {
      rows.push({
        label: cityName(c.city),
        sub: "weekly off",
        caption: `${cityName(c.city)} was shut — nothing expected.`,
        segments: [],
      });
      continue;
    }

    const down = (["P", "S", "D", "O"] as SourceKey[]).filter((k) => !c.reported[k]);
    const [four, three, two, one] = c.byCount;

    // A city short a book STILL GETS ITS COLUMNS. The counts of "in three", "in
    // two" and "in one" are real measurements either way, and the missing green
    // column is the most legible thing on the page: it says, without a sentence,
    // that nothing here could pass. What must never happen is scoring such a
    // city as a RATE against one with all four — agreeing across two records is
    // easier than across four, so a rate would render an outage as an
    // improvement. This chart shows counts, names the absent book on the city
    // itself, and repeats the reason under the plot.
    if (!fullyReported(c)) {
      // Two different reasons for a missing column, and they must not be
      // conflated: a shut warehouse SHOULD have no register, an open one that
      // did not file has a problem.
      if (!partly) noGreen.push(cityName(c.city));
    } else scored++;

    const miss = topMissing(c);
    const parts = [
      `${cityName(c.city)}: ${n(four)} in all four`,
      `${n(three)} in three`,
      `${n(two)} in two`,
      `${n(one)} in one`,
    ];
    // Spelt out rather than "(95)" beside the split above it: that count is over
    // ALL the city's units, not a subset of the "in three" bucket, and a bare
    // number sitting in the same list reads as though it were one.
    if (miss) {
      parts.push(`no ${SOURCE_NAME[miss.source]} on ${n(miss.count)} of them`);
    }
    // One direction unlogged while the other is fine — invisible in the city
    // total, and the most actionable thing this section can say. Measured on
    // Bangalore: 0 of 64 arriving reached all four, against 39 of 67 leaving.
    const skew = directionSkew(c);
    if (skew) {
      parts.push(
        `${skew.weak} units almost never do: ${n(skew.weakAll4)} of ${n(skew.weakTotal)}, against ${n(skew.strongAll4)} of ${n(skew.strongTotal)} the other way`
      );
    }
    rows.push({
      label: cityName(c.city),
      sub: `${n(c.total)} moved`,
      badge: partly
        ? { text: "Week off", tone: "muted" }
        : down.includes("P")
          ? { text: "No guard", tone: "muted" }
          : { text: "Guard ✓", tone: "good" },
      caption: parts.join(" · "),
      segments: [
        { tone: "good", value: four },
        { tone: "normal", value: three },
        { tone: "warn", value: two },
        { tone: "danger", value: one },
      ],
    });
  }

  // Nothing scoreable AND nothing measurable — every city shut, or a ledger
  // that answered with no movements at all. An absent claim beats an empty one.
  if (scored === 0 && noGreen.length === 0) return null;

  // NO INTRO PARAGRAPH. The section heading, the key under the plot and the
  // legend below it already say what is being counted; a sentence naming the
  // four records was restating the key in prose.
  const blocks: Block[] = [
    {
      kind: "bars",
      rows,
      keys: [
        { tone: "good", text: "All 4 records" },
        { tone: "normal", text: "3 of 4" },
        { tone: "warn", text: "2 of 4" },
        { tone: "danger", text: "1 of 4" },
      ],
    },
  ];

  // Only say this when it IS a different day, so the normal case stays quiet.
  if (cov.date !== data.date) {
    blocks.push({
      kind: "para",
      tone: "muted",
      text: `${fmtDate(cov.date)} is the most recent day with all four records in — gate registers reach us about a day late.`,
    });
  }

  return { id: "coverage", title: "1 · Four-way check", blocks };
}

// ─── part three: what has been open too long ─────────────────────────────────

/**
 * Severity bands for a heatmap cell, matching the key rendered beneath it.
 *
 * Bands, not a gradient: a reader compares cells against the key, and eleven
 * shades of red are indistinguishable at the size an email renders them.
 */
function heatOf(v: number): Heat {
  if (v <= 0) return 0;
  if (v <= 2) return 1;
  if (v <= 5) return 2;
  if (v <= 10) return 3;
  return 4;
}

function ageingSection(data: DigestData): Section | null {
  const a = data.ageing;
  if (!a) return null;
  if (a.total === 0 && a.staleDates.length === 0) return null;

  const blocks: Block[] = [];

  if (a.total === 0) {
    blocks.push({ kind: "para", text: "Nothing raised more than two days ago is still open." });
  } else {
    // A GRID, city x date, not a list of totals. A run of hot cells along one
    // row is a city that has been accumulating since a particular day; a hot
    // column is a bad day nobody has cleared. Per-city totals show neither.
    //
    // "Still open" and "not settled", never the internal word for these rows —
    // tests/email/vocabulary.ts bans it from every surface, and the reader has
    // no use for it.
    const g = a.grid;
    blocks.push({
      kind: "para",
      text: `Items raised in the last ${LOOKBACK_DAYS} days and still not settled, by the day they were raised.`,
    });
    blocks.push({
      kind: "table",
      columns: [
        { label: "City" },
        ...g.dates.map((d) => ({ label: fmtDateShort(d), align: "right" as const })),
        { label: "Total", align: "right" as const },
      ],
      rows: [
        ...g.rows.map((r) => [
          { text: cityName(r.city), strong: true },
          ...r.counts.map((v) => ({
            text: n(v),
            align: "right" as const,
            heat: heatOf(v),
          })),
          {
            text: n(r.total),
            align: "right" as const,
            strong: true,
            tone: r.total > 0 ? ("danger" as const) : ("muted" as const),
          },
        ]),
        [
          { text: "All cities", tone: "muted" as const },
          ...g.dailyTotals.map((v) => ({
            text: n(v),
            align: "right" as const,
            tone: "muted" as const,
            strong: true,
          })),
          { text: n(g.grandTotal), align: "right" as const, strong: true },
        ],
      ],
    });
  }

  return { id: "ageing", title: "3 · Open more than two days", blocks };
}

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
    // The marker rides the CITY cell, not the register column. The register cell
    // already reads "Weekly off" on a full off day, but on the day BEFORE — whose
    // morning half is the holiday — it reads "Not received", which blames the
    // guard for a day nobody was there. A business day runs 3pm to 3pm, so a
    // one-day closure lands inside two of them.
    {
      text: c.weekOff
        ? `${cityName(c.city)} (week off)`
        : cityName(c.city),
      tone: c.weekOff ? ("muted" as const) : undefined,
    },
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

function informationalLine(d: DigestData): string | null {
  // The tier-3 TOTAL, not the top three kinds. "123 odoo posting delay" is a
  // count followed by a lower-cased singular proper noun — not English, and the
  // labels have no plural form to fix it with.
  //
  // Self-contained, and deliberately so. This line used to open "The other N"
  // and borrowed its referent from the button underneath ("Open all 219 items").
  // The button now only says where it goes, so the sentence names both numbers
  // itself and the arithmetic still closes: tier1 + tier2 + this = open.
  const { tier3, open } = d.totals;
  if (tier3 === 0) return null;
  return `Of the ${n(open)} items open today, ${n(tier3)} need nothing from anyone.`;
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

// The masthead line. A parameter rather than a default, so the follow-up must
// name its own and cannot silently inherit "Daily stock check".
export const DIGEST_KICKER = "Daily stock check";

/**
 * Rendered-word budget for the whole email. A test asserts the worst case.
 *
 * 550. It was 250 for a one-screen note, then 450 for the founder's three-part
 * structure, and 550 once that structure became a per-city column chart with a
 * key and a seven-column grid. Each rise bought content that was asked for; the
 * alternative each time was a degradation ladder quietly deleting it. Measured
 * on live data at 550: a busy day renders ~500 with every rung unused, so the
 * ladder is a backstop again rather than a permanent state.
 */
export const WORD_BUDGET = 550;

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
  // above it.
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

  // PART ONE. Before the at-risk detail, because it answers the prior question:
  // did the four records agree at all? Omitted entirely when it cannot be
  // evidenced — see coverageSection.
  const coverage = coverageSection(data);
  if (coverage) sections.push(coverage);

  if (data.cities.length > 0) {
    sections.push({
      id: "cities",
      title: "2 · At risk, by city",
      blocks: [citySnapshot(data.cities, null)],
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

  // PART THREE. After the day's own numbers, because it is a different
  // question: not "what happened yesterday" but "what have we still not dealt
  // with". Replaces the separate follow-up email that used to go out at D+3.
  const ageing = ageingSection(data);
  if (ageing) sections.push(ageing);

  const footer: Block[] = [];
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
          // A button says where it goes, not what is behind it. The counts it
          // used to carry ("Open all 219 items on the dashboard") are now in
          // the footer line above, which reads on its own.
          label: "View in dashboard",
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
 * Order: the action list shrinks first, then the ageing detail. NEVER dropped:
 * the opening line, the four-way check, the at-risk column, the top three
 * actions, the link, and the incomplete-run banner.
 */
export function trimToBudget(sections: Section[]): Section[] {
  // MEASURE THE ACTUAL RENDER, not an estimate of it.
  //
  // This used to count the model's words and add a reserve for what the
  // renderer adds on top. Every version of that reserve has been wrong: first a
  // constant (36), then a computed one — and the computed one still missed by
  // three, so a model that passed this gate rendered at 453 against a budget of
  // 450 and failed the very test the gate exists to satisfy. Rendering the
  // candidate is a few string joins and makes the gate and the test measure the
  // identical string, so they cannot disagree again.
  const words = (s: Section[]) =>
    renderText(s, "1 January 2026", DIGEST_KICKER).trim().split(/\s+/).filter(Boolean).length;

  let out = sections;
  if (words(out) <= WORD_BUDGET) return out;

  // 1. Actions: down to three, keeping the "+N more" pointer honest.
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
          // Same wording as actionList above. Two spellings of one line meant the
          // email changed voice the moment the budget bit.
          text: `+${dropped} more ${dropped === 1 ? "job" : "jobs"}, all on the dashboard.`,
          tone: "muted",
        },
      ],
    };
  });
  if (words(out) <= WORD_BUDGET) return out;

  // 2. Part three loses its explanatory sentence.
  //
  // NEVER ITS COLUMNS. An earlier rung sliced the table to three columns, which
  // was harmless on the old four-column list and destroys the grid that replaced
  // it: the columns ARE the dates, oldest first, so slicing from the left
  // deletes exactly the days that have been outstanding longest. The heading and
  // the column labels already say what the grid is.
  //
  // Only the sentence BEFORE the table. Everything after it must survive: that
  // is where the un-rechecked-days warning lives, and dropping the one line
  // admitting the grid is incomplete would turn a partial answer into a
  // confident wrong one. A first pass at this rung filtered every para in the
  // section and did exactly that.
  out = out.map((s) => {
    if (s.id !== "ageing") return s;
    const table = s.blocks.findIndex((b) => b.kind === "table");
    if (table < 0) return s;
    return { ...s, blocks: s.blocks.filter((b, i) => i >= table || b.kind !== "para") };
  });
  if (words(out) <= WORD_BUDGET) return out;

  // 3. The grid keeps its worst three cities, plus the all-cities row.
  //
  // Rows, not columns, and last, because it is the only rung that removes a
  // city from view. The totals row and the footnote still cover EVERY city, so
  // the arithmetic stays honest; the extra clause says how many are hidden,
  // since a truncated table that does not admit it reads as the whole list.
  out = out.map((s) => {
    if (s.id !== "ageing") return s;
    return {
      ...s,
      blocks: s.blocks.map((b) => {
        if (b.kind !== "table" || b.rows.length <= 4) return b;
        // The last row is "All cities" — keep it, it is the column totals.
        const cities = b.rows.slice(0, -1);
        const totals = b.rows[b.rows.length - 1];
        const hidden = cities.length - 3;
        return {
          ...b,
          rows: [...cities.slice(0, 3), totals],
          footnote: `${b.footnote ?? ""} +${hidden} more ${hidden === 1 ? "city" : "cities"}.`.trim(),
        };
      }),
    };
  });
  if (words(out) <= WORD_BUDGET) return out;

  // 4. The four-way captions keep their four counts and shed the commentary.
  //
  // Last of all, because these captions ARE the chart for a plaintext reader —
  // the columns are pixels and carry nothing they can read. The four counts are
  // the measurement; the missing-source and one-direction clauses are the
  // interpretation, and the legend underneath still carries the general point.
  out = out.map((s) => {
    if (s.id !== "coverage") return s;
    return {
      ...s,
      blocks: s.blocks.map((b) =>
        b.kind === "bars"
          ? {
              ...b,
              rows: b.rows.map((r) => ({
                ...r,
                caption: r.caption.split(" · ").slice(0, 4).join(" · "),
              })),
            }
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
    case "bars":
      // All the copy; the columns themselves cost nothing in either renderer.
      return [
        ...b.rows.flatMap((r) =>
          [r.label, r.sub, r.badge?.text, r.caption].filter((x): x is string => !!x)
        ),
        ...(b.keys ?? []).map((k) => k.text),
        ...(b.legend ? [b.legend] : []),
      ];
    case "cta":
      return [b.label];
    default: {
      const never: never = b;
      throw new Error(`blockText: unhandled ${JSON.stringify(never)}`);
    }
  }
}
