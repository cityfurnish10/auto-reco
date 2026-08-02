// EVERY user-visible string in the digest lives in this file.
//
// The renderers emit structure only — tags, padding, bullets, rules. If you are
// about to type a word a recipient will read, it belongs here. That rule is what
// keeps the HTML and plaintext bodies saying the same thing; they previously
// drifted far enough that the plaintext reader got no dashboard link at all.
//
// Audience: the owner, who wants one question answered — can we still account
// for every unit that moved? Everything is written to that. Budget is 650 words
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

import type { Block, Heat, Section, Tone } from "./model";
import { renderText } from "./render-text";
import type { ActionItem, CityDigestRow, DigestData, RegisterState } from "./types";
import { directionSkew, fullyReported } from "./coverage";
import {
  DEFAULT_PATTERN_LIMIT,
  filedNote,
  patternRows,
  SOURCE_LABEL,
  SOURCE_ORDER,
} from "./patterns";
import { isCityOff, registerDueOn } from "../../engine/schedule";
import { addDays } from "../../engine/dates";
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

const WEEKDAY = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
function weekdayName(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  return y && m && day ? WEEKDAY[new Date(Date.UTC(y, m - 1, day)).getUTCDay()] : "";
}

const REGISTER_TEXT: Record<RegisterState, string> = {
  received: "Received",
  // Three different asks of three different people, so three different words.
  missing: "Not received",
  // Overridden with the actual weekday where the date is known — "Due Friday".
  delayed: "Due after day off",
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

// ─── the movement summary ────────────────────────────────────────────────────

/**
 * What each book recorded, per city — TWO tables, inward and outward.
 *
 * They were one table with "out / in" in every cell until the owner split them
 * (2026-08-02): inward and outward are different operations with different
 * books in play, and the combined cell made the reader do the splitting.
 *
 * "-" WHERE A BOOK DID NOT FILE, never 0. A zero would say the warehouse moved
 * nothing; the truth is nobody told us — the distinction `counts.reported`
 * exists to preserve.
 *
 * The Odoo column counts SAME-DAY postings only (run.ts passes runDate to
 * computeCountLayer). Reconciliation still matches against the ±1 day window,
 * so a next-day posting is not flagged late; reporting that window here stacked
 * three days into one column and dwarfed every other book.
 */
function movementSummary(data: DigestData): Section[] {
  const withCounts = data.cities.filter((c) => c.counts);
  if (withCounts.length === 0) return [];

  // "-" for an absent book, per the owner (was "NA").
  const num = (v: number, reported: boolean) => (reported ? n(v) : "-");

  // ONE TABLE PER DIRECTION, per the owner. Inward and outward are different
  // operations with different books in play — a combined "out / in" cell made
  // the reader do the splitting. Column order follows the owner's spec:
  // Odoo, WH (the gate register), GSheet, DT.
  const table = (dir: "IN" | "OUT"): Section => ({
    id: dir === "IN" ? "movements-in" : "movements-out",
    title: `${dir === "IN" ? "Inward" : "Outward"} · ${fmtDate(data.date)}`,
    blocks: [
      {
        kind: "table",
        columns: [
          { label: "City" },
          { label: "Odoo", align: "right" },
          { label: "WH", align: "right" },
          { label: "GSheet", align: "right" },
          { label: "DT", align: "right" },
        ],
        rows: [
          ...withCounts.map((c) => {
            const m = c.counts!;
            const odoo = dir === "IN" ? m.odooIn : m.odooOut;
            const wh = dir === "IN" ? m.physIn : m.physOut;
            const sheet = dir === "IN" ? m.sheetIn : m.sheetOut;
            const dt = dir === "IN" ? m.dtIn : m.dtOut;
            return [
              { text: cityName(c.city), strong: true },
              { text: num(odoo, m.reported.O) },
              { text: num(wh, m.reported.P), tone: m.reported.P ? undefined : ("muted" as const) },
              { text: num(sheet, m.reported.S), tone: m.reported.S ? undefined : ("muted" as const) },
              { text: num(dt, m.reported.D) },
            ];
          }),
          // Reported cells only, so an absent book never masquerades as a zero.
          (() => {
            const t = { O: [0, false], P: [0, false], S: [0, false], D: [0, false] } as
              Record<string, [number, boolean]>;
            for (const c of withCounts) {
              const m = c.counts!;
              if (m.reported.O) { t.O[0] += dir === "IN" ? m.odooIn : m.odooOut; t.O[1] = true; }
              if (m.reported.P) { t.P[0] += dir === "IN" ? m.physIn : m.physOut; t.P[1] = true; }
              if (m.reported.S) { t.S[0] += dir === "IN" ? m.sheetIn : m.sheetOut; t.S[1] = true; }
              if (m.reported.D) { t.D[0] += dir === "IN" ? m.dtIn : m.dtOut; t.D[1] = true; }
            }
            const cell = (k: string) => ({ text: t[k][1] ? n(t[k][0]) : "-", strong: true });
            return [
              { text: "Total", strong: true },
              cell("O"), cell("P"), cell("S"), cell("D"),
            ];
          })(),
        ],
      },
    ],
  });

  return [table("IN"), table("OUT")];
}

// ─── part one: the four-way check ────────────────────────────────────────────

/**
 * Which books saw each unit, per city — the four-way check.
 *
 * A TABLE OF EXACT PATTERNS, not a distribution. The chart this replaced said
 * how MANY books agreed and never which, so a reader could not tell 48 units
 * missing only the gate register from 31 missing the register AND the app —
 * and neither could be acted on. Every row now names the combination and what
 * to do about it, and the rows sum to the city's own movement count.
 *
 * DELIBERATELY NOT A PASS RATE. Measured 2026-07-29: Delhi reached all four on
 * 23 of 150 units, while the engine put NINE units of 503 at risk that day.
 * "15% passed" and "98% fine" describe the same day and only the second is true
 * in the sense a reader will take, so this section counts units per pattern and
 * never divides.
 */
function coverageSection(data: DigestData, patternLimit: number = DEFAULT_PATTERN_LIMIT): Section | null {
  const cov = data.coverage;
  if (!cov || cov.cities.length === 0) return null;

  const blocks: Block[] = [];
  let scored = 0;

  // Cities that can be scored first, biggest first; the rest sink. A city with
  // no table must not lead a section whose next two rows are the real data.
  const ordered = [...cov.cities].sort((a, b) => {
    const sa = fullyReported(a) && !isCityOff(a.city as City, cov.date) ? 1 : 0;
    const sb = fullyReported(b) && !isCityOff(b.city as City, cov.date) ? 1 : 0;
    return sb - sa || b.total - a.total || a.city.localeCompare(b.city);
  });

  for (const c of ordered) {
    if (isCityOff(c.city as City, cov.date)) {
      blocks.push({
        kind: "para",
        text: `${cityName(c.city)} — weekly off, nothing expected.`,
        tone: "muted",
      });
      continue;
    }

    const rows = patternRows(c, patternLimit);
    if (rows.length === 0) continue;
    if (fullyReported(c)) scored++;

    blocks.push({
      kind: "para",
      text: `${cityName(c.city)} · ${n(c.total)} moved`,
      strong: true,
    });

    const note = filedNote(c);
    if (note) blocks.push({ kind: "para", text: note, tone: "muted" });

    blocks.push({
      kind: "table",
      columns: [
        ...SOURCE_ORDER.map((k) => ({ label: SOURCE_LABEL[k] })),
        { label: "Count", align: "right" as const },
        { label: "What it means" },
      ],
      rows: rows.map((r) => [
        ...r.marks.map((m) => ({
          // A dash, never a cross, for a book that did not file: its silence
          // about this unit says nothing about the warehouse.
          text: m === "yes" ? "✓" : m === "no" ? "✗" : "–",
          tone: (m === "yes" ? "good" : m === "no" ? "danger" : "muted") as Tone,
        })),
        {
          text: n(r.count),
          align: "right" as const,
          strong: true,
          bar: r.share,
          tone: (r.key === "PSDO" ? "good" : "warn") as Tone,
        },
        { text: r.action, tone: (r.key === "PSDO" ? "good" : "normal") as Tone },
      ]),
    });

    // The one finding a per-city total hides: a whole direction unlogged.
    // Measured on Bangalore — 0 of 64 arriving units reached all four records
    // against 39 of 67 leaving. It survived the chart's removal on purpose.
    //
    // ONLY WHERE ALL FOUR FILED. "Reach all four" is not a measurement when one
    // book is absent — it is zero by construction. Measured 2026-08-02: Pune's
    // ops sheet lost its inward tab, and this printed "Pune logs almost nothing
    // arriving: 0 of 87 reach all four", blaming a warehouse for a spreadsheet
    // we could not read.
    const skew = fullyReported(c) ? directionSkew(c) : null;
    if (skew) {
      blocks.push({
        kind: "para",
        tone: "warn",
        text: `${cityName(c.city)} logs almost nothing ${skew.weak}: ${n(skew.weakAll4)} of ${n(skew.weakTotal)} reach all four, against ${n(skew.strongAll4)} of ${n(skew.strongTotal)} the other way.`,
      });
    }
  }

  // Nothing scoreable AND nothing measurable — every city shut, or a ledger
  // that answered with no movements. An absent claim beats an empty one.
  if (blocks.length === 0 || (scored === 0 && cov.cities.every((c) => isCityOff(c.city as City, cov.date))))
    return null;

  return { id: "coverage", title: "3 · Four-way check", blocks };
}

// ─── part three: what has been open too long ─────────────────────────────────

/**
 * Severity bands for a heatmap cell, RELATIVE to the busiest cell in the grid.
 *
 * Fixed thresholds were the first attempt and were useless: they topped out at
 * "11 or more", calibrated against a mockup whose numbers ran 1-12, while real
 * counts run 22-118. Every single cell came out maximum red, so the heatmap
 * carried no information at all — the reader saw a solid red block.
 *
 * Scaling to the grid's own maximum means the colour always says "hot FOR THIS
 * WEEK", which is the only comparison a reader can act on. A quiet week is not
 * painted red just for existing, and a catastrophic one still has a worst cell.
 */
function heatOf(v: number, max: number): Heat {
  if (v <= 0) return 0;
  if (max <= 0) return 1;
  const share = v / max;
  if (share <= 0.25) return 1;
  if (share <= 0.5) return 2;
  if (share <= 0.75) return 3;
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
    const hottest = Math.max(0, ...g.rows.flatMap((r) => r.counts));
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
            heat: heatOf(v, hottest),
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

  return { id: "ageing", title: "2 · Open more than two days", blocks };
}

/** "Delhi 31, Bangalore 25" — or "+3 cities" once the list stops being useful. */
function cityBreakdown(item: ActionItem): string {
  const named = item.cities.slice(0, 2);
  const rest = item.cities.length - named.length;
  const parts = named.map((c) => `${cityName(c.city)} ${c.count}`);
  if (rest > 0) parts.push(`+${rest} ${rest === 1 ? "city" : "cities"}`);
  return parts.join(", ");
}



function citySnapshot(
  cities: CityDigestRow[],
  footnote: string | null,
  businessDate?: string,
  calendar?: DigestData["calendar"]
): Block {
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
      // "delayed" names the actual handover day: the city's weekly off sits
      // between this board and the register, so Wednesday's book from a
      // Thursday-off warehouse is DUE FRIDAY — a schedule, not an alarm, which
      // is also why it renders muted rather than danger.
      text:
        c.register === "delayed" && businessDate
          ? `Due ${weekdayName(
              registerDueOn(c.city as City, businessDate, calendar) ?? addDays(businessDate, 2)
            )}`
          : REGISTER_TEXT[c.register],
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
 * 650. It was 250 for a one-screen note, then 450 for the founder's three-part
 * structure, 550 once that became a column chart plus a seven-column grid, and
 * 650 with the movement summary and the register-handover table on top. Each
 * rise bought content that was asked for; the alternative each time was a
 * degradation ladder quietly deleting it. Measured live at 550 the Thursday
 * board rendered 548 — two words of headroom, with the ladder already trimming
 * to get there, which is a budget doing harm rather than good.
 */
export const WORD_BUDGET = 850;

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
  }
  // The opening summary paragraph was removed at the owner's request
  // (2026-08-01): the movement summary right below carries the day's numbers,
  // and the incomplete-run banner above still fires when the check broke.

  // THE MOVEMENT SUMMARY, first. It is the raw count each book recorded, before
  // any judgement is applied to it — so it belongs above the sections that
  // interpret those counts.
  sections.push(...movementSummary(data));

  if (data.cities.length > 0) {
    sections.push({
      id: "cities",
      title: "1 · At risk, by city",
      blocks: [citySnapshot(data.cities, null, data.date, data.calendar)],
    });
  }

  // PART THREE. After the day's own numbers, because it is a different
  // question: not "what happened yesterday" but "what have we still not dealt
  // with". Replaces the separate follow-up email that used to go out at D+3.
  const ageing = ageingSection(data);
  if (ageing) sections.push(ageing);

  // THE FOUR-WAY CHECK, LAST (owner, 2026-08-02). It used to open the email as
  // "part one", on the reasoning that "did the books agree at all?" precedes
  // the at-risk detail. In practice it is the longest section by far — up to
  // nine rows per city — and it is reference material: a reader scans the
  // day's numbers and the chase list first, then comes here to see which book
  // is behind a gap. Putting it after them means the email opens with what
  // needs doing instead of with forty rows of evidence.
  const coverage = coverageSection(data);
  if (coverage) sections.push(coverage);

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

  return opts.trim === false ? sections : trimToBudget(sections, data);
}

/**
 * Deterministic degradation, applied here rather than by hand at write time.
 *
 * Order: part three's intro, then its weakest city rows, then part one's caption
 * commentary. NEVER dropped: the opening line, the four-way chart, the at-risk
 * table, the link, and the incomplete-run banner.
 */
const TRIMMED_PATTERN_LIMIT = 3;

export function trimToBudget(sections: Section[], data: DigestData): Section[] {
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

  // 1. Part three loses its explanatory sentence.
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

  // 2. The grid keeps its worst three cities, plus the all-cities row.
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

  // 3. The four-way tables keep their three biggest patterns each.
  //
  // Rewritten with the section (2026-08-02). The old rung sliced a bar caption
  // on " · " and is a silent no-op against a table — the ladder would have
  // stopped trimming exactly as this section tripled in size. patternRows folds
  // whatever it drops into one "Other combinations" row, so the Count column
  // still sums to the city's own movement total at any limit.
  out = out.map((s) =>
    s.id === "coverage" ? coverageSection(data, TRIMMED_PATTERN_LIMIT) ?? s : s
  );
  return out;
}

