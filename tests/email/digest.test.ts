import { describe, expect, it } from "vitest";
import { expectNoJargon } from "./vocabulary";
import {
  buildSections,
  digestSubject,
  renderDigestHtml,
  renderDigestText,
  visibleStrings,
  WORD_BUDGET,
  type DigestData,
} from "../../lib/email/digest";

const URL = "https://auto-reco.vercel.app/dashboard";

function digest(over: Partial<DigestData> = {}): DigestData {
  return {
    date: "2026-07-26",
    generatedAt: "2026-07-28T11:30:00.000Z",
    totals: { movements: 0, tier1: 0, tier2: 0, tier3: 0, open: 0 },
    cities: [],
    actions: [],
    informational: [],
    ...over,
  };
}

const city = (over: Partial<DigestData["cities"][number]>) => ({
  city: "DELHI",
  movements: 1204,
  tier1: 0,
  tier2: 0,
  tier3: 0,
  open: 0,
  register: "received" as const,
  topRisk: null,
  ...over,
});

const action = (over: Partial<DigestData["actions"][number]>) => ({
  label: "System-Only Entry",
  tier: 1 as const,
  count: 56,
  action: "Confirm the unit moved, or cancel the Odoo entry.",
  // The real risk sentence from lib/ui/variance-labels.ts. Only the top tier-1
  // item renders it, so the fixtures below leave the default in place and the
  // rendered output shows it exactly once.
  risk: "Odoo booked a customer movement today that nobody at the gate, on the sheet or in the app saw.",
  team: "Warehouse team",
  cities: [{ city: "DELHI", count: 31 }, { city: "BANGALORE", count: 25 }],
  ...over,
});

// ─── fixtures ────────────────────────────────────────────────────────────────

const richDay = digest({
  totals: { movements: 3825, tier1: 78, tier2: 305, tier3: 612, open: 995 },
  cities: [
    city({ city: "DELHI", tier1: 34, tier2: 96, tier3: 168, open: 298, topRisk: { label: "System-Only Entry", count: 31, team: "Warehouse team" } }),
    city({ city: "BANGALORE", movements: 861, tier1: 22, tier2: 71, tier3: 201, open: 294, register: "missing" }),
    city({ city: "MUMBAI", movements: 742, tier1: 12, tier2: 58, tier3: 172, open: 242, register: "pending" }),
    city({ city: "PUNE", movements: 520, tier1: 6, tier2: 44, tier3: 49, open: 99 }),
    city({ city: "HYDERABAD", movements: 498, tier1: 4, tier2: 36, tier3: 22, open: 62, register: "failed" }),
  ],
  actions: [
    action({}),
    action({ label: "Off-System Movement", count: 11, action: "Trace the unit, then record it on the sheet, the app and Odoo.", cities: [{ city: "DELHI", count: 7 }, { city: "MUMBAI", count: 4 }] }),
    action({ label: "Unclosed Return", count: 6, action: "Find the unit and write it into the inward register.", team: "Ops team", cities: [{ city: "PUNE", count: 4 }] }),
    action({ label: "Ghost Dispatch", count: 3, action: "Establish whether the unit left, then correct the record that is wrong.", team: "Ops team", cities: [{ city: "MUMBAI", count: 3 }] }),
    action({ label: "Odoo Entry Missing", tier: 2, count: 42, action: "Post the stock move in Odoo today.", team: "Odoo team", cities: [{ city: "DELHI", count: 19 }] }),
    action({ label: "Register Gap", tier: 2, count: 148, action: "Remind the guard post to write every unit in the book.", team: "Warehouse team", cities: [{ city: "BANGALORE", count: 60 }] }),
  ],
  informational: [
    { label: "Odoo Posting Delay", count: 123 },
    { label: "Barcode Read Error", count: 114 },
    { label: "Late Paperwork", count: 26 },
  ],
});

const quietDay = digest({
  totals: { movements: 2100, tier1: 0, tier2: 0, tier3: 0, open: 0 },
  cities: [city({}), city({ city: "PUNE", movements: 400 })],
});

const incompleteRun = digest({ runIncomplete: true });

const preMigration = digest({
  totals: { movements: 0, tier1: 3, tier2: 0, tier3: 0, open: 3 },
  cities: [city({ movements: 0, tier1: 3, open: 3 })],
  actions: [action({ count: 3, cities: [{ city: "DELHI", count: 3 }] })],
});

const allOff = digest({
  cities: [city({ register: "off" }), city({ city: "PUNE", register: "off" })],
});

const hostile = digest({
  totals: { movements: 5, tier1: 1, tier2: 0, tier3: 0, open: 1 },
  cities: [city({ city: 'A"B<script>', tier1: 1, open: 1 })],
  actions: [action({ label: "O'Brien & <b>Co</b>", count: 1, cities: [{ city: 'A"B<script>', count: 1 }] })],
});

// The founder's three-part shape, all sections live at once: the four-way
// check (part 1) on a day older than the one reported, and the ageing list
// (part 3) with one day the sweep could not refresh. This is the fixture that
// puts the new sections under the anti-drift, vocabulary and placeholder tests.
const threePart = digest({
  totals: { movements: 503, tier1: 9, tier2: 187, tier3: 145, open: 341 },
  cities: [
    city({ city: "DELHI", movements: 147, tier1: 5, tier2: 96, tier3: 60, open: 161, topRisk: { label: "Off-System Movement", count: 5, team: "Warehouse team" } }),
    city({ city: "BANGALORE", movements: 121, tier1: 4, tier2: 60, tier3: 52, open: 116 }),
    city({ city: "MUMBAI", movements: 172, register: "off", weekOff: "full" }),
  ],
  actions: [action({ label: "Off-System Movement", count: 7, cities: [{ city: "DELHI", count: 5 }, { city: "BANGALORE", count: 2 }] })],
  informational: [{ label: "Odoo Posting Delay", count: 116 }],
  coverage: {
    date: "2026-07-28",
    cities: [
      {
        city: "DELHI",
        total: 150,
        byCount: [23, 62, 29, 36],
        missing: { P: 51, S: 10, D: 40, O: 12 },
        reported: { P: true, S: true, D: true, O: true },
        inbound: { total: 75, all4: 12 },
        outbound: { total: 75, all4: 11 },
      },
      {
        city: "BANGALORE",
        total: 131,
        byCount: [39, 56, 18, 18],
        missing: { P: 54, S: 8, D: 61, O: 9 },
        reported: { P: true, S: true, D: true, O: true },
        inbound: { total: 64, all4: 0 },
        outbound: { total: 67, all4: 39 },
      },
      {
        city: "HYDERABAD",
        total: 31,
        byCount: [0, 0, 20, 11],
        missing: { P: 31, S: 31, D: 5, O: 2 },
        reported: { P: false, S: false, D: true, O: true },
        inbound: { total: 16, all4: 0 },
        outbound: { total: 15, all4: 0 },
      },
    ],
  },
  ageing: {
    total: 23,
    atRisk: 12,
    toFix: 11,
    overAWeek: 11,
    staleDates: ["2026-07-23"],
    // The heatmap: a hot row (Delhi accumulating since the 24th) and a hot
    // column (the 24th, bad everywhere) so both readings are exercised.
    grid: {
      dates: ["2026-07-24", "2026-07-25", "2026-07-26", "2026-07-27", "2026-07-28"],
      rows: [
        { city: "DELHI", counts: [12, 0, 1, 0, 1], total: 14 },
        { city: "BANGALORE", counts: [3, 1, 0, 2, 0], total: 6 },
        { city: "PUNE", counts: [0, 0, 3, 0, 0], total: 3 },
      ],
      dailyTotals: [15, 1, 4, 2, 1],
      grandTotal: 23,
    },
    cities: [
      { city: "DELHI", items: 14, atRisk: 8, toFix: 6, oldestDays: 9, kinds: [{ label: "System-Only Entry", count: 8 }, { label: "Register Gap", count: 6 }], otherKinds: 0 },
      { city: "BANGALORE", items: 6, atRisk: 4, toFix: 2, oldestDays: 4, kinds: [{ label: "Unclosed Return", count: 4 }], otherKinds: 2 },
      { city: "PUNE", items: 3, atRisk: 0, toFix: 3, oldestDays: 3, kinds: [{ label: "Odoo Entry Missing", count: 3 }], otherKinds: 0 },
    ],
  },
});

const FIXTURES: [string, DigestData][] = [
  ["richDay", richDay],
  ["quietDay", quietDay],
  ["incompleteRun", incompleteRun],
  ["preMigration", preMigration],
  ["allOff", allOff],
  ["hostile", hostile],
  ["threePart", threePart],
];

const stripTags = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rarr;/g, "→")
    .replace(/&middot;/g, "·")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");

// ─── the anti-drift test ─────────────────────────────────────────────────────

describe("digest — renderers cannot drift apart", () => {
  it.each(FIXTURES)("every string in the model reaches BOTH outputs (%s)", (_name, d) => {
    const strings = visibleStrings(buildSections(d, { dashboardUrl: URL }));
    // Case-insensitive: a renderer MAY restyle (headings and column labels are
    // upper-cased for emphasis). What it may not do is drop or reword a string.
    const html = stripTags(renderDigestHtml(d, URL)).toLowerCase();
    const text = renderDigestText(d, URL).replace(/\s+/g, " ").toLowerCase();
    for (const s of strings) {
      const needle = s.replace(/\s+/g, " ").trim().toLowerCase();
      expect(html, `HTML is missing: ${needle}`).toContain(needle);
      expect(text, `plaintext is missing: ${needle}`).toContain(needle);
    }
    expect(strings.length).toBeGreaterThan(0);
  });

  it("both parts carry the dashboard link", () => {
    // The old plaintext renderer had no link parameter at all, so a text-only
    // reader could not reach the dashboard. This is the regression guard.
    expect(renderDigestText(richDay, URL)).toContain(URL);
    expect(renderDigestHtml(richDay, URL)).toContain(`href="${URL}"`);
  });
});

// ─── vocabulary ──────────────────────────────────────────────────────────────

describe("digest — vocabulary", () => {
  it.each(FIXTURES)("uses no internal jargon (%s)", (_name, d) => {
    // The deployment's own hostname is auto-reco.vercel.app, so URLs are
    // exempt — a link is not something a reader parses for vocabulary. Every
    // other surface, including raw markup, is checked.
    const deUrl = (s: string) => s.replace(/https?:\/\/\S+/g, "[link]");
    const surfaces = [
      deUrl(renderDigestHtml(d, URL)), // raw, to catch a leak in an id/class/attr
      deUrl(stripTags(renderDigestHtml(d, URL))),
      deUrl(renderDigestText(d, URL)),
      digestSubject(d),
    ];
    // The one shared list, in tests/email/vocabulary.ts. Two copies of these
    // regexes would let the ban be enforced on one email and quietly not on
    // the other — which is exactly what happens as a codebase grows.
    expectNoJargon(Object.fromEntries(surfaces.map((v, i) => [`surface ${i}`, v])));
  });

  it.each(FIXTURES)("renders no placeholder garbage (%s)", (_name, d) => {
    for (const s of [stripTags(renderDigestHtml(d, URL)), renderDigestText(d, URL)]) {
      expect(s).not.toMatch(/\b(undefined|NaN|null)\b/);
      expect(s).not.toContain("[object Object]");
    }
  });
});

// ─── budget, escaping, subject ───────────────────────────────────────────────

describe("digest — budget", () => {
  // EVERY fixture, not just the rich day. The budget is enforced by trimToBudget
  // gating on a computed render overhead, and the terms that overhead counts
  // (table columns, list items, bar rows) grow with content — so the shape most
  // likely to breach is whichever fixture has the most of them, not whichever
  // has the most prose.
  it.each(FIXTURES)("stays within the word budget (%s)", (_name, d) => {
    const words = renderDigestText(d, URL).trim().split(/\s+/).filter(Boolean).length;
    expect(words, `rendered ${words} words`).toBeLessThanOrEqual(WORD_BUDGET);
  });

  it("keeps the top jobs, and says how many it is not showing", () => {
    const text = renderDigestText(richDay, URL);
    // The ladder now shrinks the action list first. Whatever it drops, the
    // largest job survives and the count of what is hidden stays honest.
    expect(text).toContain("System-Only Entry");
    expect(text).toMatch(/\+\d+ more jobs?, all on the dashboard\./);
  });

  it("marks a city whose weekly off falls inside the business day", () => {
    // Both shapes: the date that IS the holiday, and the day before, whose
    // morning half is. A business day runs 3pm to 3pm.
    const d = digest({
      totals: { movements: 100, tier1: 1, tier2: 0, tier3: 0, open: 1 },
      cities: [
        city({ city: "MUMBAI", tier1: 1, open: 1, weekOff: "partial" }),
        city({ city: "PUNE", weekOff: "full", register: "off" }),
        city({ city: "DELHI" }),
      ],
    });
    const text = renderDigestText(d, URL);
    expect(text).toContain("Mumbai (week off)");
    expect(text).toContain("Pune (week off)");
    expect(text).not.toContain("Delhi (week off)");
  });
});

describe("digest — escaping", () => {
  it("neutralises hostile text in the HTML", () => {
    const html = renderDigestHtml(hostile, URL);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });
});

describe("digest — subject", () => {
  it("names the busiest cities when units are at risk", () => {
    const s = digestSubject(richDay);
    // "we cannot place" rather than "to confirm": confirm is the mildest
    // possible verb for "we do not know where these are".
    expect(s).toContain("78 units we cannot place");
    expect(s).toMatch(/Delhi 34/);
    expect(s.indexOf("78")).toBeLessThan(45); // Gmail mobile truncates ~40
  });

  it("says all-clear only when every live city's register arrived", () => {
    // With its denominator: "all units accounted for" is a slogan, "all 2,100
    // units accounted for" is a fact the reader can weigh.
    expect(digestSubject(quietDay)).toContain("all 2,100 units accounted for");
  });

  it("refuses the all-clear while a register is missing", () => {
    const d = digest({
      totals: { movements: 10, tier1: 0, tier2: 0, tier3: 0, open: 0 },
      cities: [city({ register: "missing" })],
    });
    // That city ran on three sources, so a clean headline would be a lie.
    expect(digestSubject(d)).not.toMatch(/all [\d,]* ?units accounted for/);
    expect(digestSubject(d)).toContain("no guard register");
  });

  it("flags an unfinished run instead of reporting its numbers", () => {
    expect(digestSubject(incompleteRun)).toMatch(/did not finish/);
  });

  it("stays inside a readable length", () => {
    for (const [, d] of FIXTURES) expect(digestSubject(d).length).toBeLessThanOrEqual(110);
  });
});

describe("digest — the incomplete run outranks everything", () => {
  it("replaces the opening line with the banner", () => {
    const d = digest({ ...richDay, runIncomplete: true });
    const text = renderDigestText(d, URL);
    expect(text).toMatch(/did not finish/i);
    // The banner REPLACES the opening line rather than sitting above it.
    expect(text).not.toContain("closed at 3pm");
  });
});

describe("digest — the founder's three parts", () => {
  const text = () => renderDigestText(threePart, URL);

  it("renders all three numbered parts, in order", () => {
    const t = text();
    const one = t.indexOf("1 · FOUR-WAY CHECK");
    const two = t.indexOf("2 · AT RISK, BY CITY");
    const three = t.indexOf("3 · OPEN MORE THAN TWO DAYS");
    expect(one).toBeGreaterThan(-1);
    expect(two).toBeGreaterThan(one);
    expect(three).toBeGreaterThan(two);
  });

  it("scales every city's bar against the SAME maximum", () => {
    // A shared scale is the point of the chart: per-city percentages would draw
    // Hyderabad's 18 movements the same size as Mumbai's 172. So the widest bar
    // belongs to whichever city holds the single largest value, and no bar may
    // exceed it.
    const bars = text()
      .split("\n")
      .filter((l) => /^\s+[█▓▒░]+$/.test(l))
      .map((l) => l.trim().length);
    expect(bars.length).toBeGreaterThan(1);
    expect(Math.max(...bars)).toBeLessThanOrEqual(40 * 4);
    // Delhi holds the largest single segment (62) so it must draw the longest.
    expect(bars[0]).toBe(Math.max(...bars));
  });

  it("never states a four-way pass RATE", () => {
    // 23 of 150 is 15%, while that same day put 9 units of 503 at risk. A
    // percentage here reads as "85% of stock is missing", which is false.
    expect(text()).not.toMatch(/\b\d+% (of )?(units )?(pass|passed|traced|agree)/i);
  });

  it("names the day it measured when it is not the day reported", () => {
    expect(text()).toContain("28 July 2026 is the most recent day with all four records in");
  });

  it("excludes a day the sweep could not re-check, and says so", () => {
    // Silence here would let an un-rechecked day read as "nothing outstanding".
    expect(text()).toContain("23 Jul could not be re-checked today");
  });

  it("splits at-risk from records-to-fix, and never reports one total", () => {
    // Measured across 27-28 Jul 2026: 188 units at risk against 535 records to
    // fix. A single "683 still open" reads as 683 pieces of missing stock when
    // three quarters of it is a missing register line.
    const t = text();
    expect(t).toContain("12 still unaccounted for, 11 records to correct");
    expect(t).not.toContain("23 in total");
  });

  it("lays part three out as a city-by-date grid with both totals", () => {
    // A run of hot cells along one row is a city accumulating since a given
    // day; a hot column is a bad day nobody has cleared. Per-city totals show
    // neither, which is why the grid replaced the list.
    const t = text();
    expect(t).toMatch(/CITY\s+24 JUL\s+25 JUL\s+26 JUL\s+27 JUL\s+28 JUL\s+TOTAL/);
    expect(t).toMatch(/Delhi\s+12\s+0\s+1\s+0\s+1\s+14/); // the hot row
    expect(t).toMatch(/All cities\s+15\s+1\s+4\s+2\s+1\s+23/); // the column totals
  });
});

describe("digest — model snapshot", () => {
  // Snapshot the MODEL, not the HTML: a colour tweak should not churn this, and
  // the diff a reviewer reads is "what the email says".
  it("richDay", () => {
    expect(buildSections(richDay, { dashboardUrl: URL })).toMatchSnapshot();
  });

  // Pins the three-part shape: section ids and order, the bar segments, and the
  // exact wording of the four-way legend and the un-rechecked-day line.
  it("threePart", () => {
    expect(buildSections(threePart, { dashboardUrl: URL })).toMatchSnapshot();
  });
});
