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
import { renderHtml } from "../../lib/email/digest/render-html";

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

// One city's four-way coverage. The section is the only surface left that
// prints a per-city line, so the tests that used to reach the at-risk table go
// through here now.
const coverageCity = (
  over: Partial<NonNullable<DigestData["coverage"]>["cities"][number]> = {}
): NonNullable<DigestData["coverage"]>["cities"][number] => ({
  city: "DELHI",
  total: 150,
  byCount: [23, 62, 29, 36],
  missing: { P: 51, S: 10, D: 40, O: 12 },
  reported: { P: true, S: true, D: true, O: true },
  inbound: { total: 75, all4: 12 },
  outbound: { total: 75, all4: 11 },
  patterns: { PSDO: 23, "-SDO": 62, "-S-O": 29, "---O": 36 },
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

// `counts` so the hostile city name reaches a rendered table. It used to arrive
// there through the at-risk section; with that gone, the movement summary is
// the surface that prints a city name, and the escaping test has to keep
// exercising a real one.
const hostile = digest({
  totals: { movements: 5, tier1: 1, tier2: 0, tier3: 0, open: 1 },
  cities: [
    city({
      city: 'A&B"<script>',
      tier1: 1,
      open: 1,
      counts: {
        physIn: 1, physOut: 1, sheetIn: 1, sheetOut: 1,
        odooIn: 1, odooOut: 1, dtIn: 1, dtOut: 1,
        reported: { P: true, S: true, D: true, O: true },
      },
    }),
  ],
  actions: [action({ label: "O'Brien & <b>Co</b>", count: 1, cities: [{ city: 'A&B"<script>', count: 1 }] })],
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
        patterns: { PSDO: 23, "-SDO": 62, "-S-O": 29, "---O": 36 },
      },
      {
        city: "BANGALORE",
        total: 131,
        byCount: [39, 56, 18, 18],
        missing: { P: 54, S: 8, D: 61, O: 9 },
        reported: { P: true, S: true, D: true, O: true },
        inbound: { total: 64, all4: 0 },
        outbound: { total: 67, all4: 39 },
        patterns: { PSDO: 39, "-SDO": 56, "-S-O": 18, "P---": 18 },
      },
      {
        city: "HYDERABAD",
        total: 31,
        byCount: [0, 0, 20, 11],
        missing: { P: 31, S: 31, D: 5, O: 2 },
        reported: { P: false, S: false, D: true, O: true },
        inbound: { total: 16, all4: 0 },
        outbound: { total: 15, all4: 0 },
        patterns: { "--DO": 20, "---O": 11 },
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

describe("digest — column widths", () => {
  const table = (columns: { label: string; width?: string }[]) =>
    renderHtml(
      [{ id: "t", blocks: [{ kind: "table", columns, rows: [columns.map(() => ({ text: "x" }))] }] }],
      "1 Jan 2026",
      "Kicker"
    );

  it("emits a declared width as BOTH the attribute and the property", () => {
    // Outlook reads the attribute; everything else reads the property. One
    // without the other is a width that works in half the inboxes.
    const html = table([{ label: "Wide", width: "45%" }]);
    expect(html).toContain('width="45%"');
    expect(html).toContain("width:45%;");
  });

  it("fixes the layout only when the author said what the columns are worth", () => {
    // Otherwise a declared width is a suggestion the content can overrule —
    // and every table without widths keeps sizing itself, as it always has.
    expect(table([{ label: "Wide", width: "45%" }])).toContain("table-layout:fixed");
    expect(table([{ label: "Plain" }])).not.toContain("table-layout:fixed");
  });
});

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

  it("marks a shut city as shut, and expects nothing of it", () => {
    // The "(week off)" badge and the "Due Friday" register cell lived in the
    // at-risk table, which the owner removed on 2026-08-02. What survives is
    // the four-way check's own line for a closed city — and it still has to
    // name only the city that is actually shut. Thursday is the off day, so a
    // Wednesday board carries no badge at all.
    const wed = digest({
      date: "2026-07-29",
      totals: { movements: 100, tier1: 1, tier2: 0, tier3: 0, open: 1 },
      cities: [city({ city: "MUMBAI", tier1: 1, open: 1, register: "delayed" })],
      coverage: { date: "2026-07-29", cities: [coverageCity({ city: "MUMBAI" })] },
    });
    expect(renderDigestText(wed, URL)).not.toContain("weekly off");

    // 2026-07-30 is a Thursday: Pune is shut, Delhi is not.
    const thu = digest({
      date: "2026-07-30",
      totals: { movements: 100, tier1: 1, tier2: 0, tier3: 0, open: 1 },
      cities: [city({ city: "PUNE", weekOff: "full", register: "off" })],
      coverage: {
        date: "2026-07-30",
        cities: [coverageCity({ city: "PUNE", total: 0, patterns: {} }), coverageCity({ city: "DELHI" })],
      },
    });
    const t = renderDigestText(thu, URL);
    expect(t).toContain("Pune — weekly off, nothing expected.");
    expect(t).not.toContain("Delhi — weekly off");
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
  it("is the movement register and its date, nothing else", () => {
    expect(digestSubject(richDay)).toBe("Movement Register- 26-July-2026");
    expect(digestSubject(threePart)).toBe("Movement Register- 26-July-2026");
  });

  it("says the same thing on an unfinished run", () => {
    // Recorded, not asserted as good: the subject used to replace everything
    // with "the check did not finish, do not act on these figures". A broken
    // run is now indistinguishable from a clean one until the mail is opened.
    expect(digestSubject(incompleteRun)).toBe("Movement Register- 26-July-2026");
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

  it("renders both numbered parts, in order", () => {
    // The four-way check sits at the END (owner, 2026-08-02): it is the longest
    // section and it is reference material, so the email opens with what needs
    // doing rather than with forty rows of evidence. "At risk, by city" used to
    // be part one and was removed the same day — it summarised the two tables
    // that bracketed it.
    const t = text();
    const one = t.indexOf("1 · OPEN MORE THAN TWO DAYS");
    const two = t.indexOf("2 · FOUR-WAY CHECK");
    expect(one).toBeGreaterThan(-1);
    expect(two).toBeGreaterThan(one);
    expect(t).not.toContain("AT RISK, BY CITY");
  });

  it("puts the movement summary above both, and the link below them", () => {
    const t = text();
    expect(t.indexOf("INWARD ·")).toBeLessThan(t.indexOf("1 · OPEN MORE THAN TWO DAYS"));
    expect(t.indexOf("2 · FOUR-WAY CHECK")).toBeLessThan(t.indexOf("View in dashboard"));
  });

  it("drops the intro sentence that restated the key in prose", () => {
    for (const s of [renderDigestText(threePart, URL), stripTags(renderDigestHtml(threePart, URL))]) {
      expect(s).not.toContain("checked against all four records");
    }
  });

  it("never states a four-way pass RATE", () => {
    // 23 of 150 is 15%, while that same day put 9 units of 503 at risk. A
    // percentage here reads as "85% of stock is missing", which is false.
    expect(text()).not.toMatch(/\b\d+% (of )?(units )?(pass|passed|traced|agree)/i);
  });

  it("reports the email's own day — no second date to reconcile", () => {
    // The section used to walk back to the newest fully-covered day, so it
    // carried a "29 July is the most recent day with all four records in"
    // caveat. Two things retired that: the reconcile moved to 20:00 IST, and a
    // book that has not filed now shows a dash rather than a cross.
    for (const surface of [renderDigestText(threePart, URL), stripTags(renderDigestHtml(threePart, URL))]) {
      expect(surface).not.toContain("most recent day with all four records in");
    }
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
