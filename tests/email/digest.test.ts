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
  watch: [
    { label: "Register Gap", city: "MUMBAI", days: 5, consecutive: true, today: 148, median: 62, trend: "worsening" },
    { label: "Ghost Dispatch", city: "PUNE", days: 4, consecutive: true, today: 0, median: 9, trend: "cleared" },
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

const FIXTURES: [string, DigestData][] = [
  ["richDay", richDay],
  ["quietDay", quietDay],
  ["incompleteRun", incompleteRun],
  ["preMigration", preMigration],
  ["allOff", allOff],
  ["hostile", hostile],
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
  it("the busiest realistic day stays within the word budget", () => {
    const words = renderDigestText(richDay, URL).trim().split(/\s+/).filter(Boolean).length;
    expect(words, `rendered ${words} words`).toBeLessThanOrEqual(WORD_BUDGET);
  });

  it("drops the watch list before it drops an action", () => {
    const text = renderDigestText(richDay, URL);
    // Actions are what the owner acts on; the watch list is context.
    expect(text).toContain("System-Only Entry");
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
  it("replaces the opening line with the banner and drops the watch list", () => {
    const d = digest({ ...richDay, runIncomplete: true });
    const text = renderDigestText(d, URL);
    expect(text).toMatch(/did not finish/i);
    expect(text).not.toContain("Worth watching");
  });
});

describe("digest — model snapshot", () => {
  // Snapshot the MODEL, not the HTML: a colour tweak should not churn this, and
  // the diff a reviewer reads is "what the email says".
  it("richDay", () => {
    expect(buildSections(richDay, { dashboardUrl: URL })).toMatchSnapshot();
  });
});
