// Load the guard app in a real browser and report what it actually does.
//
// WHY THIS EXISTS. A blank white screen survived three attempted fixes because
// nothing here could see a browser console. Types, lint, build and 700 mocked
// tests all passed while the page rendered nothing — so every diagnosis was a
// guess, and every verification was a person picking up a phone.
//
//   node scripts/smoke-gate.mjs [url]

import { chromium } from "playwright";

const BASE = process.argv[2] ?? "https://auto-reco.vercel.app";
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); process.exitCode = 1; };

const browser = await chromium.launch();
// A real phone, so viewport-dependent layout and touch paths are exercised.
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
  permissions: [],
});
const page = await ctx.newPage();

const errors = [];
const failedRequests = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(`UNCAUGHT: ${e.message}`));
page.on("requestfailed", (r) => failedRequests.push(`${r.url()} — ${r.failure()?.errorText}`));
page.on("response", (r) => {
  if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`);
});

console.log(`\n${BASE}/scan\n`);
await page.goto(`${BASE}/scan`, { waitUntil: "networkidle", timeout: 45_000 }).catch((e) => bad(`navigation: ${e.message}`));
await page.waitForTimeout(2500);

const text = (await page.locator("body").innerText().catch(() => "")).trim();
const visible = text.replace(/\s+/g, " ").slice(0, 300);

console.log(`  visible text: ${visible || "(NOTHING)"}\n`);

if (!visible) bad("the page renders no text at all — this is the blank screen");
else ok("the page renders text");

// The states the app is allowed to land on. Anything else means it hung.
const known = ["Gate Check", "Starting", "not paired", "Who is on duty",
               "Enter PIN", "Something went wrong", "Today"];
const landed = known.find((k) => visible.includes(k));
landed ? ok(`landed on: "${landed}"`) : bad("did not reach any known screen");

if (errors.length) {
  console.log("\n  console errors:");
  for (const e of [...new Set(errors)].slice(0, 8)) console.log(`    • ${e.slice(0, 220)}`);
} else ok("no console errors");

if (failedRequests.length) {
  console.log("\n  failed requests:");
  for (const f of [...new Set(failedRequests)].slice(0, 8)) console.log(`    • ${f.slice(0, 160)}`);
} else ok("no failed requests");

await browser.close();
