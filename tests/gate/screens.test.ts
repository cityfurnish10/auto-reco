// Every screen the guard app can be in must exist in the component.
//
// WHY THIS IS A TEST. Nine screens — who, pin, checkin, today, newtrip, scan,
// resolve, manual, closetrip — were deleted by a slice replacement that took
// everything between two markers, and NOTHING caught it. The code stayed valid,
// types passed, lint passed, the build passed and 700 tests passed. The app
// rendered its header and then had nothing to draw, and the only detector left
// was a person on a phone reporting a blank screen.
//
// A missing render block is invisible to a compiler. So it is pinned here: the
// Screen union and the JSX must agree, and adding a screen without drawing it
// fails the build.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SRC = "app/(gate)/scan/scan-app.tsx";

describe("guard app screens", () => {
  it("renders every screen named in the Screen type", () => {
    const src = readFileSync(SRC, "utf8");

    const union = src.slice(src.indexOf("type Screen ="), src.indexOf(";", src.indexOf("type Screen =")));
    const declared = [...union.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    const rendered = new Set(
      [...src.matchAll(/\{screen === "([a-z]+)"/g)].map((m) => m[1])
    );

    expect(declared.length).toBeGreaterThan(10);
    const missing = declared.filter((s) => !rendered.has(s));
    expect(
      missing,
      `Screens declared but never drawn: ${missing.join(", ")}. ` +
        `The app would render its header and nothing else on those screens.`
    ).toEqual([]);
  });

  it("draws no screen that the Screen type does not name", () => {
    const src = readFileSync(SRC, "utf8");
    const union = src.slice(src.indexOf("type Screen ="), src.indexOf(";", src.indexOf("type Screen =")));
    const declared = new Set([...union.matchAll(/"([a-z]+)"/g)].map((m) => m[1]));
    const rendered = [...new Set([...src.matchAll(/\{screen === "([a-z]+)"/g)].map((m) => m[1]))];
    expect(rendered.filter((s) => !declared.has(s))).toEqual([]);
  });
});
