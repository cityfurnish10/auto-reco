import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// THE BUG THESE PIN, AND WHY IT IS A SOURCE SCAN.
//
// Reported 12 Sep 2026: a manager could not attach a photo while enrolling a
// guard, and the form went on saying "Needs a photo". Nothing was wrong with
// the photo. Two separate faults, and what they had in common is the whole
// point of this file — BOTH FAILED WITHOUT SAYING ANYTHING.
//
//   1. "Upload photo" is a styled <label> around a hidden file input that is
//      disabled while the 6.7MB face model loads. A disabled input inside a
//      label swallows the click and opens no file dialog at all — measured in
//      WebKit and Chromium — while the label itself looked completely ready.
//      The camera button beside it said "Preparing…" through the same window,
//      so the pair was actively misleading rather than merely slow.
//
//   2. An image the browser cannot decode (HEIC, which `image/*` offers on
//      every iPhone) reached face-api as a zero-dimension image and threw
//      `Dimensions.constructor - expected width and height to be valid
//      numbers`. That throw comes off a promise inside face-api's own task
//      chain that the caller never awaits, so A TRY/CATCH AT THE CALL SITE
//      DOES NOT CATCH IT — measured. It lands as an uncaught page error, the
//      error state is never set, and the form reads "Needs a photo".
//
// There is no component-rendering harness in this repo, and the faults live in
// DOM semantics and in a third-party library's throw behaviour — neither of
// which a unit test on the surrounding logic would have caught. So the rules
// are enforced on the source, in the same spirit as
// barcode-display-enforced.test.ts: the next person cannot re-arm either one
// silently, which is exactly how both arrived.

const ROOTS = ["app", "components"];
const EXT = /\.tsx$/;

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (EXT.test(full)) out.push(full);
  }
  return out;
}

const files = () => ROOTS.flatMap(walk).map((f) => ({
  rel: f.replace(/\\/g, "/"),
  text: readFileSync(f, "utf-8"),
}));

/**
 * Every `<input type="file" …>` tag, whole.
 *
 * Not a regex over `[^>]*`: a JSX handler contains `=>`, so that stops dead at
 * the first arrow and reports a tag as missing whatever came after it. Found
 * by this test failing against code that was already correct.
 */
function fileInputs(text: string): { tag: string; index: number }[] {
  const out: { tag: string; index: number }[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf("<input", from);
    if (start === -1) break;
    from = start + 6;
    // Walk to the tag's own end, skipping the `>` inside `=>` and inside
    // braces, which is where a JSX handler lives.
    let depth = 0, end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0 && text[i - 1] !== "=") { end = i + 1; break; }
    }
    if (end === -1) break;
    const tag = text.slice(start, end);
    if (/type="file"/.test(tag)) out.push({ tag, index: start });
    from = end;
  }
  return out;
}

/** The <label> element wrapping a given file input, source-wise. */
function labelAround(text: string, inputIndex: number): string {
  const before = text.slice(0, inputIndex);
  const open = before.lastIndexOf("<label");
  return open === -1 ? "" : text.slice(open, inputIndex);
}

describe("a file picker never fails in silence", () => {
  it("a file input's label reacts to EVERY condition that disables it", () => {
    // The trap: `disabled` on the input alone. The label keeps its full-colour
    // button styling and its pointer cursor, the click reaches a disabled
    // input, and nothing happens — no dialog, no message, no clue.
    //
    // "Does the label mention being disabled at all?" is NOT enough, and this
    // test was written that way first: the broken code carried `busy ?
    // "opacity-60" : …` and sailed through, because the condition it ignored
    // was the OTHER one — `model === "loading"`, the whole 6.7MB window where
    // the fault actually lived. A check that cannot fail on the regression it
    // guards is worse than no check. So every operand of the input's own
    // `disabled` expression has to appear in the label too.
    const offenders: string[] = [];

    for (const f of files()) {
      for (const { tag, index } of fileInputs(f.text)) {
        const dis = tag.match(/disabled=\{([^}]*)\}/);
        if (!dis) continue;
        const label = labelAround(f.text, index);
        if (!label) continue;

        const norm = (x: string) => x.replace(/\s+/g, " ").trim();
        const conditions = dis[1].split("||").map(norm).filter(Boolean);
        const labelText = norm(label);
        const missing = conditions.filter((cnd) => !labelText.includes(cnd));

        if (missing.length) {
          offenders.push(
            `${f.rel}: label ignores ${missing.map((m) => `\`${m}\``).join(" and ")}`
          );
        } else if (!/pointer-events-none|aria-disabled|opacity-|cursor-not-allowed/.test(label)) {
          offenders.push(`${f.rel}: label names the conditions but still looks enabled`);
        }
      }
    }

    expect(
      offenders,
      "A <label> wrapping a disabled file input must show that it is disabled,\n" +
        "for EVERY condition that disables the input. A disabled input swallows\n" +
        "the click and opens NO file dialog, so a label that still looks like a\n" +
        "button is a control that lies about being ready.\n\n" +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("a file input clears its value, so re-picking the same file still fires", () => {
    // "Let me just try that again" with the same photo fires no change event
    // at all unless the value is cleared — the worst possible response to
    // somebody whose first attempt already failed without explanation.
    const offenders: string[] = [];

    for (const f of files()) {
      for (const { tag } of fileInputs(f.text)) {
        if (!/onChange/.test(tag)) continue;
        if (!/\.value\s*=\s*""/.test(tag)) {
          offenders.push(`${f.rel}: file input's onChange never clears e.target.value`);
        }
      }
    }

    expect(
      offenders,
      "A file input's onChange must clear e.target.value, or selecting the same\n" +
        "file twice is a click that cannot do anything.\n\n" + offenders.join("\n")
    ).toEqual([]);
  });

  it("an image is proved to have decoded before it reaches face detection", () => {
    // describe() is face-api. Handed an image that never decoded it throws
    // from inside its own chain, uncatchably from here, and the handler dies
    // without setting an error. The guard has to be in front of it.
    const offenders: string[] = [];

    for (const f of files()) {
      if (!/\bdescribe\s*\(/.test(f.text)) continue;
      for (const m of f.text.matchAll(/\bdescribe\s*\(\s*(\w+)\s*\)/g)) {
        const arg = m[1];
        // A video element is the camera path: it cannot be an undecodable
        // file, and readyState is what guards it there.
        if (/video/i.test(arg)) continue;
        const before = f.text.slice(0, m.index!);
        const guarded = new RegExp(`${arg}\\.naturalWidth`).test(before);
        if (!guarded) {
          offenders.push(`${f.rel}: describe(${arg}) with no ${arg}.naturalWidth check before it`);
        }
      }
    }

    expect(
      offenders,
      "Check naturalWidth before calling describe(). An image that failed to\n" +
        "decode — HEIC is the one that will actually happen — makes face-api throw\n" +
        "from a promise this caller never awaits, so try/catch here does not help.\n\n" +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("the enrolment upload names HEIC, so the message is actionable", () => {
    // "Could not read that photo" sends a manager back to try the same file.
    // Naming the format, and where to change it, ends the loop.
    const f = files().find((x) => x.rel.endsWith("app/(dashboard)/gate/gate-client.tsx"));
    expect(f, "gate-client.tsx not found").toBeTruthy();
    expect(f!.text).toMatch(/HEIC/);
    expect(f!.text).toMatch(/Most Compatible/);
  });
});
