import { describe, expect, it } from "vitest";
import {
  noHistoryVerdict,
  singlePassVerdict,
  unfinishedVerdict,
  verdictFor,
  VERDICT_CLASS,
  VERDICT_ICON,
  type Verdict,
} from "../../lib/ui/recheck-verdict";
import { expectNoJargon } from "../email/vocabulary";

const ALL: Verdict[] = [
  verdictFor({ clearedTrustworthy: true, newlyRaisedTrustworthy: true, lostInB: [], lostInA: [] }),
  verdictFor({ clearedTrustworthy: false, newlyRaisedTrustworthy: true, lostInB: ["S"], lostInA: [] }),
  verdictFor({ clearedTrustworthy: false, newlyRaisedTrustworthy: true, lostInB: [], lostInA: [] }),
  verdictFor({ clearedTrustworthy: true, newlyRaisedTrustworthy: false, lostInB: [], lostInA: ["D"] }),
  verdictFor({ clearedTrustworthy: false, newlyRaisedTrustworthy: false, lostInB: ["P"], lostInA: ["S"] }),
  singlePassVerdict(null),
  singlePassVerdict("budget: 47231ms elapsed of 40000ms"),
  unfinishedVerdict(),
  noHistoryVerdict(),
];

describe("the gate", () => {
  it("shows a change ONLY when both checks read the same books", () => {
    // THE rule this page exists for. If a verdict that lost a book ever returns
    // showDelta true, the page will print "75 items fixed" about a day on which a
    // source was simply down.
    for (const v of ALL) {
      if (v.id === "comparable") expect(v.showDelta).toBe(true);
      else expect(v.showDelta, `${v.id} must not show a change figure`).toBe(false);
    }
  });

  it("never lets recheck-saw-less through, whatever the reason", () => {
    const byMask = verdictFor({
      clearedTrustworthy: false, newlyRaisedTrustworthy: true, lostInB: ["S"], lostInA: [],
    });
    const byFloor = verdictFor({
      clearedTrustworthy: false, newlyRaisedTrustworthy: true, lostInB: [], lostInA: [],
    });
    expect(byMask.id).toBe("recheck-saw-less");
    expect(byFloor.id).toBe("recheck-saw-less");
    expect(byMask.showDelta).toBe(false);
    expect(byFloor.showDelta).toBe(false);
  });
});

describe("the copy", () => {
  it("uses no internal vocabulary, in any branch", () => {
    for (const v of ALL) {
      expectNoJargon({ [`${v.id} title`]: v.title, [`${v.id} body`]: v.body });
    }
  });

  it("names the missing book rather than saying a source failed", () => {
    const v = verdictFor({
      clearedTrustworthy: false, newlyRaisedTrustworthy: true, lostInB: ["S"], lostInA: [],
    });
    expect(v.body).toContain("ops sheet");
    expect(v.body).toContain("not stock being put right");
  });

  it("lists several missing books readably", () => {
    const v = verdictFor({
      clearedTrustworthy: false, newlyRaisedTrustworthy: true, lostInB: ["P", "S", "D"], lostInA: [],
    });
    expect(v.body).toContain("guard's book, ops sheet and delivery app");
  });

  it("explains a first check that saw less as nothing new going wrong", () => {
    const v = verdictFor({
      clearedTrustworthy: true, newlyRaisedTrustworthy: false, lostInB: [], lostInA: ["D"],
    });
    expect(v.id).toBe("recheck-saw-more");
    expect(v.body).toContain("always there");
  });

  it("says a skipped re-check is normal, not broken", () => {
    const v = singlePassVerdict("budget: 47231ms elapsed of 40000ms");
    expect(v.body).toContain("one day in three");
    // Never a raw millisecond figure in front of a warehouse owner.
    expect(v.body).not.toMatch(/\d{4,}ms/);
  });

  it("renders no placeholder garbage", () => {
    for (const v of ALL) {
      for (const s of [v.title, v.body]) {
        expect(s).not.toMatch(/\b(undefined|NaN|null)\b/);
        expect(s.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe("styling", () => {
  it("has a literal class string for every tone", () => {
    // Tailwind scans lib/**, so a computed class generates no CSS at all.
    for (const v of ALL) {
      expect(VERDICT_CLASS[v.tone]).toMatch(/^card p-4 /);
      expect(VERDICT_ICON[v.tone]).toBeTruthy();
    }
  });
});
