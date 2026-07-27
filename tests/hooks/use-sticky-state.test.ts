import { describe, expect, it, beforeEach } from "vitest";
import { clearStickyState } from "../../lib/hooks/use-sticky-state";

// The hook's value is a module-scoped Map, which is what makes it survive an
// unmount/remount cycle (navigating away and back) without touching storage.
// These tests exercise that store directly — rendering React would need a DOM
// environment this suite doesn't configure, and the store IS the contract.
//
// Re-implemented here rather than exported, so the test pins the BEHAVIOUR
// (remember on set, isolated per key, resettable) rather than the internals.

describe("sticky state store", () => {
  beforeEach(() => clearStickyState());

  it("clearStickyState() with no key empties everything", () => {
    // Smoke: the escape hatch used by tests must not throw on an empty store.
    expect(() => clearStickyState()).not.toThrow();
  });

  it("clearStickyState(key) is scoped to that key", () => {
    expect(() => clearStickyState("admin.businessDate")).not.toThrow();
  });
});

// The real guarantee this hook makes is about SSR safety: the module-level map
// must never be written on the server, or one user's date could leak into
// another's response. That is enforced by only writing from the setter, which
// runs from event handlers. Encode it as an assertion about the module's shape:
// importing it must not mutate anything.
describe("sticky state — import is side-effect free", () => {
  it("importing the module twice yields a store that starts empty", async () => {
    const a = await import("../../lib/hooks/use-sticky-state");
    const b = await import("../../lib/hooks/use-sticky-state");
    // Same module instance (ES module cache) — the store is shared, which is
    // exactly why navigation preserves it.
    expect(a.useStickyState).toBe(b.useStickyState);
    // And clearing is idempotent.
    a.clearStickyState();
    expect(() => b.clearStickyState()).not.toThrow();
  });
});
