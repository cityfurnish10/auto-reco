// Which Tailwind colour tokens still resolve to a HARDCODED hex rather than a
// brand variable?
//
// COUNTING CLASS NAMES WAS THE WRONG QUESTION, and the first version of this
// script asked it: it reported thirteen "legacy" uses that were perfectly fine,
// because the names had been repointed at brand variables. What matters is not
// which name a component reaches for, it is what that name resolves to.
//
// So this reads tailwind.config.ts and reports any colour token still holding a
// literal hex. Those are the ones a retheme cannot reach — the sidebar wore the
// old near-black for exactly this reason while everything around it changed.
//
// A few literals are legitimate and listed as expected: pure white and the
// on-accent foregrounds, which are chosen for contrast rather than for brand.
//
//   node scripts/audit-legacy-classes.mjs

import { readFileSync } from "node:fs";

const CONFIG = "tailwind.config.ts";
const text = readFileSync(CONFIG, "utf8");
const block = text.slice(text.indexOf("colors: {"), text.indexOf("borderRadius:"));

/** Literals that are deliberate: contrast choices, not brand colours. */
const EXPECTED = new Set(["on-primary", "on-error", "white", "black"]);

const hard = [];
const soft = [];
for (const m of block.matchAll(/"?([a-z0-9-]+)"?\s*:\s*"([^"]+)"/g)) {
  const [, name, value] = m;
  if (value.startsWith("var(")) soft.push(name);
  else if (/^#|^rgb/.test(value)) (EXPECTED.has(name) ? soft : hard).push(`${name}: ${value}`);
}

// A hardcoded token nothing uses is clutter. One that IS used is a hole the
// next retheme will fall through, exactly as the sidebar did — so the two are
// counted separately rather than as one alarming number.
const { readdirSync, statSync } = await import("node:fs");
const { join } = await import("node:path");
const walk = (dir, out = []) => {
  for (const e of readdirSync(dir)) {
    const q = join(dir, e);
    if (statSync(q).isDirectory()) { if (e !== "node_modules") walk(q, out); }
    else if (/\.tsx?$/.test(e)) out.push(q);
  }
  return out;
};
const files = ["app", "components", "lib/ui", "lib/email"]
  .flatMap((r) => { try { return walk(r); } catch { return []; } });
const src = files.map((f) => readFileSync(f, "utf8")).join("\n");
const PREFIXES = ["bg", "text", "border", "ring", "fill", "stroke", "from", "to", "divide"];
const usedCount = (name) => PREFIXES.reduce((n, pre) => {
  // Not preceded or followed by a word char or hyphen, so `text-primary` does
  // not match inside `text-text-primary`.
  const re = new RegExp(`(?<![\\w-])${pre}-${name}(?![\\w-])`, "g");
  return n + (src.match(re) ?? []).length;
}, 0);

const live = [], dead = [];
for (const h of hard) {
  const name = h.split(":")[0];
  (usedCount(name) > 0 ? live : dead).push(`${h}   (${usedCount(name)} use${usedCount(name) === 1 ? "" : "s"})`);
}

console.log(`\n${soft.length} token(s) resolve to a brand variable (or are a deliberate literal)`);
console.log(`${live.length} hardcoded token(s) ARE STILL USED — a retheme cannot reach these`);
console.log(`${dead.length} hardcoded token(s) unused — clutter, harmless\n`);
for (const l of live) console.log(`  ⚠ ${l}`);
if (!live.length) console.log("  (nothing on screen renders a hardcoded colour)");
console.log("");
