import { describe, expect, it } from "vitest";
import {
  compareToSnapshot,
  followUpSubject,
  isStillOpen,
  renderFollowUpHtml,
  renderFollowUpText,
  buildFollowUpSections,
  FOLLOW_UP_WORD_BUDGET,
  type CurrentRow,
} from "../../lib/email/followup";
import { visibleStrings } from "../../lib/email/digest/model";
import { VARIANCE } from "../../lib/engine/variance-names";
import { RESOLVED_LATE_NOTE } from "../../lib/engine/resolution";
import { flaggedKeyOf, type TotalsSnapshot } from "../../lib/email/followup/snapshot";
import { expectNoJargon, stripTags, wordCount } from "./vocabulary";

// ── fixtures ────────────────────────────────────────────────────────────────

const counts = (t1: number, t2: number) => ({
  movements: 500,
  tier1: t1,
  tier2: t2,
  tier3: 40,
  open: t1 + t2 + 40,
  flagged: t1 + t2,
});

/** A row that is genuinely still open and tier 1. */
const openRow = (city: string, barcode: string, over: Partial<CurrentRow> = {}): CurrentRow => ({
  city,
  direction: "OUT",
  barcode,
  variance_name: VARIANCE.GATE_ONLY, // tier 1 outward
  job_type: null,
  bucket: "REAL",
  note: null,
  status: "open",
  ...over,
});

function snapshot(rows: CurrentRow[], over: Partial<TotalsSnapshot> = {}): TotalsSnapshot {
  const byCity = new Map<string, number>();
  for (const r of rows) byCity.set(r.city, (byCity.get(r.city) ?? 0) + 1);
  return {
    v: 1,
    date: "2026-07-24",
    sentAt: "2026-07-25T11:15:00.000Z",
    overall: counts(rows.length, 0),
    cities: [...byCity.entries()].map(([city, n]) => ({ city, ...counts(n, 0) })),
    keys: rows.map(flaggedKeyOf),
    keysTruncated: false,
    ...over,
  };
}

const three = [openRow("DELHI", "CF1"), openRow("DELHI", "CF2"), openRow("MUMBAI", "CF3")];

// ── the comparison ──────────────────────────────────────────────────────────

describe("compareToSnapshot", () => {
  it("counts a closed item as closed", () => {
    const c = compareToSnapshot(snapshot(three), [
      three[0],
      { ...three[1], status: "closed" },
      three[2],
    ]);
    expect(c.flagged).toBe(3);
    expect(c.stillOpen).toBe(2);
    expect(c.closed).toBe(1);
  });

  it("treats being worked on and awaiting approval as STILL OPEN", () => {
    // X was built with `status !== 'closed'`. Using `=== 'open'` here would make
    // an item resolve the moment a manager clicks start-work — the delta would
    // measure clicks, not stock. And an admin can still reject an approval.
    const c = compareToSnapshot(snapshot(three), [
      { ...three[0], status: "in_progress" },
      { ...three[1], status: "pending_approval" },
      three[2],
    ]);
    expect(c.stillOpen).toBe(3);
    expect(c.closed).toBe(0);
    expect(isStillOpen("in_progress")).toBe(true);
    expect(isStillOpen("pending_approval")).toBe(true);
    expect(isStillOpen("closed")).toBe(false);
  });

  it("counts a row the engine downgraded as resolved, not open", () => {
    // The dominant resolution path: the gap cleared on the re-check, so the row
    // falls to tier 3 and leaves the flagged population.
    const c = compareToSnapshot(snapshot(three), [
      { ...three[0], bucket: "INFO", note: RESOLVED_LATE_NOTE },
      three[1],
      three[2],
    ]);
    expect(c.stillOpen).toBe(2);
    expect(c.closed).toBe(1);
  });

  it("keeps a superseded-but-still-broken unit in STILL OPEN, not newly flagged", () => {
    // THE regression guard for unit-key matching. resolveStaleOpenVariances
    // DELETEs a row when the same (direction, barcode) re-fires under a
    // different name; the replacement carries a fresh identity. Matching on the
    // full row key would call this a NEW problem and quietly flatter the
    // numbers — the unit is the same unit, and it is still broken.
    const renamed: CurrentRow = { ...three[0], variance_name: VARIANCE.SHEET_ONLY };
    const c = compareToSnapshot(snapshot(three), [renamed, three[1], three[2]]);
    expect(c.stillOpen).toBe(3);
    expect(c.newlyFlagged).toBe(0);
  });

  it("reports items raised since the email separately, never inside Y", () => {
    // Late postings genuinely create new gaps. Folding them into Y would break
    // the reader's arithmetic: flagged − stillOpen would stop equalling closed.
    const c = compareToSnapshot(snapshot(three), [...three, openRow("PUNE", "CF9")]);
    expect(c.stillOpen).toBe(3);
    expect(c.newlyFlagged).toBe(1);
    expect(c.flagged - c.stillOpen).toBe(c.closed);
  });

  it("counts one unit once, even when it raises two rows", () => {
    // classifyViews can push a ladder hit AND a duplicate-scan hit for the same
    // unit. Counting both would make Y exceed X for an artefact reason.
    const dup: CurrentRow = { ...three[0], variance_name: VARIANCE.SHEET_ONLY };
    const c = compareToSnapshot(snapshot(three), [three[0], dup, three[1], three[2]]);
    expect(c.stillOpen).toBe(3);
  });

  it("handles a reopened item honestly rather than printing a negative", () => {
    const snap = snapshot(three, { overall: counts(2, 0) });
    const c = compareToSnapshot(snap, three);
    expect(c.flagged).toBe(2);
    expect(c.stillOpen).toBe(3);
    expect(c.moreThanReported).toBe(true);
  });

  it("splits what remains by tier", () => {
    const t2 = openRow("DELHI", "CF4", {
      variance_name: VARIANCE.PICKUP_ODOO_OPEN, // "Odoo Entry Missing", tier 2
    });
    const c = compareToSnapshot(snapshot([...three, t2]), [...three, t2]);
    expect(c.stillOpenTier1).toBe(3);
    expect(c.stillOpenTier2).toBe(1);
  });

  it("keeps a city in the table even when everything there closed", () => {
    const c = compareToSnapshot(snapshot(three), [three[0], three[1]]);
    const mum = c.cities.find((x) => x.city === "MUMBAI")!;
    expect(mum.stillOpen).toBe(0);
    expect(mum.closed).toBe(1);
  });

  it("suppresses the newly-flagged claim when the key list was capped", () => {
    const c = compareToSnapshot(snapshot(three, { keysTruncated: true }), [
      ...three,
      openRow("PUNE", "CF9"),
    ]);
    expect(c.newlyFlaggedUnknown).toBe(true);
  });
});

// ── the email ───────────────────────────────────────────────────────────────

const render = (rows: CurrentRow[], current: CurrentRow[], over: Partial<TotalsSnapshot> = {}) =>
  compareToSnapshot(snapshot(rows, over), current);

const CASES = {
  someOpen: render(three, [three[0], { ...three[1], status: "closed" }, three[2]]),
  allClosed: render(three, three.map((r) => ({ ...r, status: "closed" }))),
  moreThanReported: render(three, three, { overall: counts(2, 0) }),
  withNew: render(three, [...three, openRow("PUNE", "CF9")]),
};

describe("the follow-up email", () => {
  it("says every string in both the HTML and the plaintext", () => {
    // Strictly stronger than a snapshot: it fails the moment either renderer
    // skips a block, which is the drift that made this model exist.
    for (const [name, c] of Object.entries(CASES)) {
      const opts = { dashboardUrl: "https://example.test/dashboard" };
      // Case-insensitive, like the digest's own anti-drift test: a renderer MAY
      // restyle (headings and column labels are upper-cased). What it may not do
      // is drop or reword a string.
      const html = stripTags(renderFollowUpHtml(c, opts)).toLowerCase();
      const text = renderFollowUpText(c, opts).replace(/\s+/g, " ").toLowerCase();
      for (const s of visibleStrings(buildFollowUpSections(c, "24 July 2026", opts))) {
        const want = s.replace(/\s+/g, " ").toLowerCase();
        expect(html, `${name}: HTML missing "${s}"`).toContain(want);
        expect(text, `${name}: text missing "${s}"`).toContain(want);
      }
    }
  });

  it("uses no internal vocabulary, in any branch", () => {
    for (const [name, c] of Object.entries(CASES)) {
      expectNoJargon({
        [`${name} subject`]: followUpSubject(c),
        [`${name} html`]: renderFollowUpHtml(c),
        [`${name} text`]: renderFollowUpText(c),
      });
    }
  });

  it("never prints a closed count it cannot stand behind", () => {
    // Y > X: the closed figure would be negative, so it is omitted entirely and
    // the reason is stated rather than clamped to zero.
    const text = renderFollowUpText(CASES.moreThanReported);
    expect(text).toContain("more than the report showed");
    expect(text).not.toMatch(/-\d/);
    expect(text).toContain("can rise");
  });

  it("states the progress plainly when everything closed", () => {
    const text = renderFollowUpText(CASES.allClosed);
    expect(text).toContain("All 3 are now closed");
    expect(text).toContain("is left to chase");
  });

  it("keeps items raised since the email out of the headline", () => {
    const text = renderFollowUpText(CASES.withNew);
    expect(text).toContain("3 are still open");
    expect(text).toContain("They are not counted above");
  });

  it("warns when the figures could not be refreshed", () => {
    const text = renderFollowUpText(CASES.someOpen, { staleSince: "2026-07-26T11:02:00Z" });
    expect(text.toLowerCase()).toContain("may be out of date");
    // Never a raw ISO stamp in an owner-facing email.
    expect(text).not.toMatch(/\dT\d\d:\d\d/);
  });

  it("says why a closed warehouse could not improve", () => {
    const text = renderFollowUpText(CASES.someOpen, { restDayCities: ["MUMBAI", "PUNE"] });
    expect(text).toContain("Mumbai, Pune were closed that day");
  });

  it("stays inside its word budget", () => {
    for (const [name, c] of Object.entries(CASES)) {
      const n = wordCount(renderFollowUpText(c, { dashboardUrl: "https://x.test/d" }));
      expect(n, `${name} ran to ${n} words`).toBeLessThanOrEqual(FOLLOW_UP_WORD_BUDGET);
    }
  });

  it("renders no placeholder garbage", () => {
    for (const c of Object.values(CASES)) {
      for (const out of [renderFollowUpHtml(c), renderFollowUpText(c)]) {
        expect(out).not.toMatch(/\b(undefined|NaN|null)\b/);
        expect(out).not.toContain("[object Object]");
      }
    }
  });

  it("escapes hostile text from a source system", () => {
    const hostile = compareToSnapshot(
      snapshot(three, { cities: [{ city: 'A"B<script>', ...counts(1, 0) }] }),
      three
    );
    expect(renderFollowUpHtml(hostile)).not.toContain("<script>");
  });
});

describe("the subject line", () => {
  it("leads with the number, and threads separately from the digest", () => {
    expect(followUpSubject(CASES.someOpen)).toBe(
      "Follow-up: 24 Jul stock check — 2 of 3 items still open"
    );
    expect(followUpSubject(CASES.allClosed)).toBe(
      "Follow-up: 24 Jul stock check — all 3 items closed"
    );
    expect(followUpSubject(CASES.moreThanReported)).toBe(
      "Follow-up: 24 Jul stock check — 3 still open, 2 first reported"
    );
  });

  it("keeps the count where a phone will still show it", () => {
    for (const c of Object.values(CASES)) {
      const s = followUpSubject(c);
      expect(s.length).toBeLessThanOrEqual(100);
      expect(s.slice(0, 45)).toMatch(/\d/);
    }
  });
});
