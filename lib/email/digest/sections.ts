// EVERY user-visible string in the digest lives in this file.
//
// The renderers emit structure only — tags, padding, bullets, rules. If you are
// about to type a word a recipient will read, it belongs here. That rule is what
// keeps the HTML and plaintext bodies saying the same thing; they previously
// drifted far enough that the plaintext reader got no dashboard link at all.
//
// Audience: the owner, who wants one question answered — can we still account
// for every unit that moved? Everything is written to that. Budget is 450 words
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

import type { BarRow, Block, Section } from "./model";
import { renderText } from "./render-text";
import type { ActionItem, CityDigestRow, DigestData, RegisterState } from "./types";
import { directionSkew, fullyReported, SOURCE_NAME, topMissing, type SourceKey } from "./coverage";
import { isCityOff } from "../../engine/schedule";
import type { City } from "../../sample-data";

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

// ─── part one: the four-way check ────────────────────────────────────────────

/**
 * The 4/3/2/1 split per city, drawn.
 *
 * Deliberately NOT a pass rate. Measured 2026-07-29, the first date with all
 * four sources live: Delhi reached all four on 23 of 150 units, Bangalore 39 of
 * 131 — while the engine put NINE units of 503 at risk that day. "15% passed"
 * and "98% fine" describe the same day, and only the second is true in the sense
 * a reader will take. So the bar shows the distribution, the caption names the
 * source that is actually missing, and the legend says in one line that three of
 * four is a paperwork gap rather than lost stock. Without that line this section
 * is actively misleading, which is why it is not optional.
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

  for (const c of ordered) {
    const off = isCityOff(c.city as City, cov.date);
    // "movements checked", NOT "units". Part 2's city table says "Units moved"
    // from run_city_stats, and the two counters legitimately disagree: the
    // ledger holds one row per barcode PER DIRECTION and records a
    // direction-conflict unit against BOTH legs (migration 0015:41-43), so it
    // runs slightly higher. Measured 29 Jul: Delhi 150 vs 147, Bangalore 131 vs
    // 121, and exact agreement for the three cities that were shut. Normally the
    // two sections report different DATES so nobody sees them together — but
    // when they coincide, two numbers for one word reads as an error.
    const label = `${cityName(c.city)} — ${n(c.total)} ${c.total === 1 ? "movement" : "movements"} checked`;

    if (off) {
      rows.push({ label: cityName(c.city), caption: "Weekly off — nothing expected.", segments: [] });
      continue;
    }
    // A city short a source gets NO bar. Scoring it against the books that did
    // file would draw a LONGER bar than a city with all four, because agreeing
    // against two records is easier than four — an outage rendering as an
    // improvement, the flattering-direction error this codebase refuses.
    if (!fullyReported(c)) {
      const down = (["P", "S", "D", "O"] as SourceKey[]).filter((k) => !c.reported[k]);
      rows.push({
        label: cityName(c.city),
        caption: `Not comparable — the ${down.map((k) => SOURCE_NAME[k]).join(" and ")} did not file.`,
        segments: [],
      });
      continue;
    }

    scored++;
    const [four, three, two, one] = c.byCount;
    const pct = (x: number) => (c.total > 0 ? (x / c.total) * 100 : 0);
    const miss = topMissing(c);
    const parts = [
      `${n(four)} in all four`,
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
      label,
      caption: parts.join(" · "),
      segments: [
        { tone: "good", pct: pct(four) },
        { tone: "muted", pct: pct(three) },
        { tone: "warn", pct: pct(two) },
        { tone: "danger", pct: pct(one) },
      ],
    });
  }

  if (scored === 0) return null;

  const blocks: Block[] = [
    {
      kind: "para",
      text: `Every unit that moved on ${fmtDate(cov.date)}, checked against all four records: gate register, ops sheet, delivery app and Odoo.`,
    },
    {
      kind: "bars",
      rows,
      // The sentence that stops this section being read as a catastrophe.
      legend:
        "Three of four is usually a missing gate-register line — a paperwork gap, not missing stock. The units genuinely at risk are in the next section.",
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

function ageingSection(data: DigestData): Section | null {
  const a = data.ageing;
  if (!a) return null;
  if (a.total === 0 && a.staleDates.length === 0) return null;

  const blocks: Block[] = [];

  if (a.total === 0) {
    blocks.push({ kind: "para", text: "Nothing raised more than two days ago is still open." });
  } else {
    // TWO COLUMNS, NEVER ONE TOTAL. Measured across 27-28 Jul: 188 units at
    // risk against 535 records to fix. "683 still open" reads as 683 pieces of
    // missing stock, and three quarters of it is a missing register line.
    blocks.push({
      kind: "table",
      columns: [
        { label: "City" },
        { label: "At risk", align: "right" },
        { label: "To fix", align: "right" },
        { label: "Oldest", align: "right" },
      ],
      rows: a.cities.map((c) => [
        { text: cityName(c.city) },
        {
          text: n(c.atRisk),
          align: "right" as const,
          strong: c.atRisk > 0,
          tone: c.atRisk > 0 ? ("danger" as const) : ("muted" as const),
        },
        { text: n(c.toFix), align: "right" as const },
        { text: `${c.oldestDays}d`, align: "right" as const },
      ]),
      footnote:
        `${n(a.atRisk)} still unaccounted for, ${n(a.toFix)} records to correct` +
        (a.overAWeek > 0 ? `, ${n(a.overAWeek)} of them older than a week.` : "."),
    });
  }

  // Never fold an un-rechecked day into the counts silently. "Still open" is
  // only true as of the last time that day was reconciled.
  if (a.staleDates.length > 0) {
    // Named while the list is short, counted once it is not. Spelling out five
    // dates costs ten words of a 450-word email to tell the reader something a
    // single number says better — and the list can reach seven.
    const which =
      a.staleDates.length <= 2
        ? a.staleDates.map(fmtDateShort).join(" and ")
        : `${a.staleDates.length} earlier days`;
    blocks.push({
      kind: "para",
      tone: "warn",
      text: `${which} could not be re-checked today, so anything still open then is not counted above.`,
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
 * 450, raised from 250 when the founder's three-part structure landed. The old
 * figure was set for a one-screen note; this is a structured report with a
 * coverage section, a per-city visual and an ageing table, and the rich-day
 * fixture rendered 245 of 250 before any of that existed. Raising the ceiling is
 * deliberate — the alternative was cutting detail the previous rewrite added.
 */
export const WORD_BUDGET = 450;

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

  // PART THREE. After the day's own numbers, because it is a different
  // question: not "what happened yesterday" but "what have we still not dealt
  // with". Replaces the separate follow-up email that used to go out at D+3.
  const ageing = ageingSection(data);
  if (ageing) sections.push(ageing);

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

  // 2. The ageing table drops its "What" column and keeps the counts.
  //
  // This rung REPLACED a dead one. The old rung matched a footer para starting
  // "Also logged", and no builder has emitted that string since the copy
  // rewrite — a grep for it returned exactly one hit, the matcher itself. So the
  // ladder has been running on a single live rung for some time.
  //
  // The kinds are the widest thing on the page and the least load-bearing: which
  // city has how many, and how old the oldest is, is what earns the section.
  out = out.map((s) => {
    if (s.id !== "ageing") return s;
    return {
      ...s,
      blocks: s.blocks.map((b) =>
        b.kind === "table" && b.columns.length > 3
          ? {
              ...b,
              columns: b.columns.slice(0, 3),
              rows: b.rows.map((r) => r.slice(0, 3)),
            }
          : b
      ),
    };
  });
  if (words(out) <= WORD_BUDGET) return out;

  // 3. The ageing table keeps its worst three cities.
  //
  // Rows, only after columns, because a city's two numbers are worth more than
  // any single column of them — and this is last because it is the only rung
  // that removes a whole city from view. The footnote still totals ALL cities,
  // so the count stays honest; the extra clause says how many are hidden, since
  // a truncated table that does not admit it reads as the complete list.
  out = out.map((s) => {
    if (s.id !== "ageing") return s;
    return {
      ...s,
      blocks: s.blocks.map((b) => {
        if (b.kind !== "table" || b.rows.length <= 3) return b;
        const hidden = b.rows.length - 3;
        return {
          ...b,
          rows: b.rows.slice(0, 3),
          footnote: `${b.footnote ?? ""} +${hidden} more ${hidden === 1 ? "city" : "cities"}.`.trim(),
        };
      }),
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
      // Labels, captions, legend. The bar itself costs no words in either
      // renderer — it is one line of block glyphs in plaintext and a table row
      // in HTML — so counting only the copy keeps the budget honest.
      return [...b.rows.flatMap((r) => [r.label, r.caption]), ...(b.legend ? [b.legend] : [])];
    case "cta":
      return [b.label];
    default: {
      const never: never = b;
      throw new Error(`blockText: unhandled ${JSON.stringify(never)}`);
    }
  }
}
