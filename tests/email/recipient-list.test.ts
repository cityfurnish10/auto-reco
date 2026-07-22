import { describe, expect, it } from "vitest";
import {
  EMPTY_RECIPIENTS,
  addRecipient,
  candidatesOf,
  listsOf,
  removeRecipient,
  seedDefaults,
  toggleSlot,
  type RecipientState,
} from "../../lib/email/recipient-list";

const DEFAULTS = ["ops@cityfurnish.com", "audit@cityfurnish.com"];
const ROSTER = ["manager.ban@cityfurnish.com", "manager.pun@cityfurnish.com"];

const seeded = (): RecipientState => seedDefaults(EMPTY_RECIPIENTS, DEFAULTS);

describe("email recipient list — add / remove / slots", () => {
  it("seeds defaults into To once, without clobbering later choices", () => {
    let s = seeded();
    expect(listsOf(s).to).toEqual(DEFAULTS);
    // admin moves one to Cc; a re-seed (data refetch) must NOT reset it
    s = toggleSlot(s, DEFAULTS[0], "cc");
    s = seedDefaults(s, DEFAULTS);
    expect(listsOf(s).cc).toEqual([DEFAULTS[0]]);
    expect(listsOf(s).to).toEqual([DEFAULTS[1]]);
  });

  it("adds a valid manual email into the list and To; rejects invalid input", () => {
    const ok = addRecipient(seeded(), "  cfo@cityfurnish.com ");
    expect(ok.error).toBeUndefined();
    expect(candidatesOf(ok.state, DEFAULTS, ROSTER)).toContain("cfo@cityfurnish.com");
    expect(listsOf(ok.state).to).toContain("cfo@cityfurnish.com");

    for (const bad of ["", "not-an-email", "a@b", "sp ace@x.com"]) {
      const res = addRecipient(seeded(), bad);
      expect(res.error).toBeTruthy();
      expect(res.state).toEqual(seeded()); // unchanged
    }
  });

  it("adding a duplicate neither duplicates the list nor resets its slot", () => {
    let s = addRecipient(seeded(), "cfo@cityfurnish.com").state;
    s = toggleSlot(s, "cfo@cityfurnish.com", "bcc");
    s = addRecipient(s, "cfo@cityfurnish.com").state;
    expect(s.extra.filter((e) => e === "cfo@cityfurnish.com")).toHaveLength(1);
    expect(listsOf(s).bcc).toEqual(["cfo@cityfurnish.com"]); // slot preserved
  });

  it("REMOVE: a manually-added email disappears from the list and from every send list", () => {
    let s = addRecipient(seeded(), "cfo@cityfurnish.com").state;
    s = removeRecipient(s, "cfo@cityfurnish.com");
    expect(candidatesOf(s, DEFAULTS, ROSTER)).not.toContain("cfo@cityfurnish.com");
    const lists = listsOf(s);
    expect([...lists.to, ...lists.cc, ...lists.bcc]).not.toContain("cfo@cityfurnish.com");
    expect(s.extra).not.toContain("cfo@cityfurnish.com");
  });

  it("REMOVE: a default (env-configured) recipient is hidden and loses its To slot", () => {
    const s = removeRecipient(seeded(), DEFAULTS[0]);
    expect(candidatesOf(s, DEFAULTS, ROSTER)).not.toContain(DEFAULTS[0]);
    expect(listsOf(s).to).toEqual([DEFAULTS[1]]);
    // and a later re-seed (preview refetch) must not resurrect it
    const reseeded = seedDefaults(s, DEFAULTS);
    expect(candidatesOf(reseeded, DEFAULTS, ROSTER)).not.toContain(DEFAULTS[0]);
    expect(listsOf(reseeded).to).toEqual([DEFAULTS[1]]);
  });

  it("REMOVE: a roster user is hidden even though the roster still contains them", () => {
    let s = seeded();
    s = toggleSlot(s, ROSTER[0], "cc"); // admin had selected them
    s = removeRecipient(s, ROSTER[0]);
    expect(candidatesOf(s, DEFAULTS, ROSTER)).not.toContain(ROSTER[0]);
    expect(listsOf(s).cc).toEqual([]);
  });

  it("re-adding a removed address restores it (removal is not permanent)", () => {
    let s = removeRecipient(seeded(), DEFAULTS[0]);
    s = addRecipient(s, DEFAULTS[0]).state;
    expect(candidatesOf(s, DEFAULTS, ROSTER)).toContain(DEFAULTS[0]);
    expect(listsOf(s).to).toContain(DEFAULTS[0]);
    expect(s.removed).not.toContain(DEFAULTS[0]);
  });

  it("slot toggling: move between To/Cc/Bcc; clicking the active slot deselects", () => {
    let s = seeded();
    s = toggleSlot(s, DEFAULTS[0], "cc");
    expect(listsOf(s).cc).toContain(DEFAULTS[0]);
    s = toggleSlot(s, DEFAULTS[0], "cc"); // same slot again → deselected
    const lists = listsOf(s);
    expect([...lists.to, ...lists.cc, ...lists.bcc]).not.toContain(DEFAULTS[0]);
    // still listed though — deselect ≠ remove
    expect(candidatesOf(s, DEFAULTS, ROSTER)).toContain(DEFAULTS[0]);
  });

  it("candidates dedupe overlap between defaults, roster and extras", () => {
    const s = addRecipient(seeded(), ROSTER[0]).state; // manually adds a roster address
    const c = candidatesOf(s, DEFAULTS, ROSTER);
    expect(c.filter((e) => e === ROSTER[0])).toHaveLength(1);
  });
});
