// Can a guard get OUT of every screen they can get into?
//
// The screens test next door proves each declared screen is drawn somewhere.
// That is a weaker claim than it sounds: a screen can render perfectly and
// still be a trap, with no back control and no footer, leaving a guard to
// force-quit the app in front of a waiting driver. Nine screens once vanished
// entirely and every type-level check passed, so "it compiles" has already
// been shown to mean very little here.
//
// This reads the source rather than driving a browser on purpose — it is a
// completeness check over ALL screens, including ones a walkthrough would need
// a camera, a shift and an override to reach.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SRC = readFileSync("app/(gate)/scan/scan-app.tsx", "utf8");

/** Every screen the type declares. */
const DECLARED = (() => {
  const block = SRC.slice(SRC.indexOf("type Screen ="), SRC.indexOf(";", SRC.indexOf("type Screen =")));
  return [...block.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
})();

/** The block of JSX that renders one screen, from its guard to the next one. */
function blockFor(screen: string): string {
  const start = SRC.indexOf(`{screen === "${screen}"`);
  if (start === -1) return "";
  const next = DECLARED
    .map((s) => SRC.indexOf(`{screen === "${s}"`, start + 10))
    .filter((i) => i > start)
    .sort((a, b) => a - b)[0];
  return SRC.slice(start, next === undefined ? SRC.length : next);
}

/**
 * Screens that are deliberately without an exit, and why.
 *
 * Each entry is a decision somebody made, not an oversight — which is the
 * whole point of listing them: a new dead end has to be argued for here rather
 * than simply appearing.
 */
const NO_EXIT_BY_DESIGN: Record<string, string> = {
  loading: "Transient. It replaces itself as soon as bootstrap answers or fails.",
  unpaired: "There is genuinely nowhere to go: the phone has no token and only a manager's link can fix it.",
  problem: "Carries its own retry, and the guard has nothing else they could usefully do.",
  who: "The root of the app. Backing out of it would mean leaving.",
  randomcheck: "Deliberately not dismissible without answering — but 'not now' IS an answer and is offered inside it.",
  resolve: "A decision that must be made: it offers Cancel and Allow, both of which leave.",
  scan: "The scanner's own footer carries Done, and its bar carries a back control.",
};

describe("no screen is a trap", () => {
  it("every screen is actually rendered", () => {
    const missing = DECLARED.filter((s) => !SRC.includes(`{screen === "${s}"`));
    expect(missing, `declared but never drawn: ${missing.join(", ")}`).toEqual([]);
  });

  it("every screen offers a way out", () => {
    const trapped: string[] = [];
    for (const s of DECLARED) {
      if (s in NO_EXIT_BY_DESIGN) continue;
      const block = blockFor(s);
      // A back control, a footer button, or an explicit setScreen — any of the
      // three is an exit. What matters is that there is at least one.
      const hasExit = /BackBtn|setScreen\(|onClose|gfoot/.test(block);
      if (!hasExit) trapped.push(s);
    }
    expect(trapped, `no way out of: ${trapped.join(", ")}`).toEqual([]);
  });

  it("the deliberate dead ends each carry a reason", () => {
    // Guards the list itself: an entry added to silence this test without a
    // justification is the failure mode it exists to prevent.
    for (const [screen, why] of Object.entries(NO_EXIT_BY_DESIGN)) {
      expect(DECLARED, `${screen} is listed but is not a screen`).toContain(screen);
      expect(why.length, `${screen} needs a real reason`).toBeGreaterThan(30);
    }
  });

  it("every screen with a back control renders something above it", () => {
    // A bare BackBtn on an empty screen is how the blank-page bug looked.
    for (const s of DECLARED) {
      const block = blockFor(s);
      if (!block.includes("BackBtn")) continue;
      expect(block.length, `${s} renders a back button and almost nothing else`).toBeGreaterThan(300);
    }
  });
});

describe("the guard can always leave", () => {
  it("signing out is reachable without ending a shift", () => {
    // A shared phone at a gate: whoever is holding it must be able to hand it
    // over, and that cannot require finishing your own day first.
    expect(SRC).toMatch(/switchGuard/);
  });

  it("ending a shift is reachable and asks first", () => {
    expect(SRC).toMatch(/endShift/);
    expect(SRC).toMatch(/confirmEndShift/);
  });

  it("the queue is reachable, so 'not sent yet' is never a mystery", () => {
    expect(SRC).toMatch(/setScreen\("queue"\)/);
  });

  it("history is reachable from the home screen", () => {
    expect(SRC).toMatch(/setScreen\("history"\)/);
  });
});
