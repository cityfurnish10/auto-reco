// Photograph the guard app, screen by screen.
//
// Written because "the UI is poor" is impossible to act on and impossible to
// argue with until somebody is looking at the same pixels. Everything else
// here tests behaviour; this looks at the thing.
//
// Real phone dimensions, real WebKit, the server stubbed at the network edge
// so every screen renders from the actual application code.
//
//   node scripts/shoot-gate.mjs [url] [outDir]

import { webkit } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:3100";
const OUT = process.argv[3] ?? "/tmp/gate-shots";
mkdirSync(OUT, { recursive: true });

const GUARD_ID = "11111111-1111-1111-1111-111111111111";
const DESCRIPTOR = Array.from({ length: 128 }, (_, i) => Math.sin(i * 1.7) * 0.124);

const browser = await webkit.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
});
const page = await ctx.newPage();

const json = (route, body) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

let onShift = false, withTrip = false;

await ctx.route("**/api/gate/session", (route) =>
  route.request().method() === "POST"
    ? json(route, { ok: true, guard: { id: GUARD_ID, name: "Ramesh Kumar" } })
    : json(route, {
        site: { city: "DELHI", code: "GUR" },
        guards: [
          { guardId: GUARD_ID, name: "Ramesh Kumar", employeeCode: "G-014", descriptor: DESCRIPTOR, enrolled: true },
          { guardId: "b", name: "Sudhir Kumar", employeeCode: "G-021", descriptor: DESCRIPTOR, enrolled: true },
          { guardId: "c", name: "Lovelash Kumar", employeeCode: "G-033", descriptor: null, enrolled: false },
        ],
      }));

await ctx.route("**/api/gate/bootstrap*", (route) => json(route, {
  guard: { id: GUARD_ID, name: "Ramesh Kumar" },
  businessDate: "2026-08-25",
  site: { code: "GUR", label: "Gurgaon", lat: 28.6, lng: 77.2, radiusM: 400 },
  config: { outwardPhotoSampleRate: 0.1, expectedCheckLive: false, completenessShown: true },
  openTrip: withTrip
    ? { id: "t1", client_trip_id: "ct1", direction: "OUT", vehicle_no: "DL1LAH6369", opened_at: "2026-08-25T09:00:00Z" }
    : null,
  openShift: onShift ? { id: "s1", client_shift_id: "cs1", checked_in_at: "2026-08-25T03:40:00Z" } : null,
  expected: [], expectedCount: 0,
}));

await ctx.route("**/api/gate/fleet", (route) => json(route, {
  vehicles: ["DL1L2AG3248", "DL1LAH6369", "DL1LAR3256", "DL1LAR7552"],
  agents: ["Kartik", "Lovelash Kumar", "MUKUL KUMAR", "sandeep singh", "Sudhir Kumar"],
  source: "dt",
}));

await ctx.route("**/api/gate/expected", (route) => json(route, {
  items: [
    { barcode: "FUMYHA23030062", barcode_canon: "FUMYHA23030062", direction: "OUT", product: "Ergonomic Chair", so_number: "ON-RET-GUR-76196", ticket_id: null, customer: "K S Gudi", picking_ref: "GUR/OUT/3957", delivery_address: "12 MG Road, Sector 14" },
    { barcode: "AP815719030952", barcode_canon: "AP815719030952", direction: "OUT", product: "Study Desk", so_number: "ON-RET-GUR-76196", ticket_id: null, customer: "K S Gudi", picking_ref: "GUR/OUT/3957", delivery_address: "12 MG Road, Sector 14" },
    { barcode: "FUMY5U23080048", barcode_canon: "FUMY5U23080048", direction: "OUT", product: "Queen Bed", so_number: "ON-RET-GUR-76201", ticket_id: null, customer: "A Sharma", picking_ref: "GUR/OUT/3957", delivery_address: "44 Golf Course Road" },
  ],
  businessDate: "2026-08-25", refreshed: true, stale: false, reason: null,
}));

await ctx.route("**/api/gate/sync", (route) => json(route, {
  ok: true, trips: [], scans: [], voids: [], shifts: [], faceChecks: [],
  photos: [], selfies: [], bucket: "e", selfieBucket: "a", clockWarnings: [], truncated: false,
}));
await ctx.route("**/api/gate/history*", (route) => json(route, { trips: [] }));

await ctx.addInitScript(() => localStorage.setItem("gate.deviceToken", "shot"));

const shots = [];
async function shoot(name, note) {
  await page.waitForTimeout(700);
  const file = `${OUT}/${String(shots.length + 1).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: file });
  shots.push({ name, note, file });
  console.log(`  ${file}  — ${note}`);
}

const tap = async (label) => {
  const el = page.getByText(label, { exact: false }).first();
  if (await el.count()) { await el.click().catch(() => {}); await page.waitForTimeout(500); return true; }
  return false;
};

console.log(`\nShooting ${BASE}/scan into ${OUT}\n`);
await page.goto(`${BASE}/scan`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await shoot("who", "the name list — first thing a guard sees");

await tap("Ramesh Kumar");
await shoot("pin", "PIN entry");

for (const d of "1234") {
  const k = page.getByRole("button", { name: d, exact: true }).first();
  if (await k.count()) await k.click().catch(() => {});
}
await page.waitForTimeout(1400);
await shoot("checkin", "check-in, camera blocked — the state a guard hits with no permission yet");

onShift = true;
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);
for (const d of "1234") {
  const k = page.getByRole("button", { name: d, exact: true }).first();
  if (await k.count()) await k.click().catch(() => {});
}
await page.waitForTimeout(1500);
await shoot("today", "the home screen for a guard on duty");

await tap("Start trip");
await page.waitForTimeout(1200);
await shoot("newtrip", "starting a trip — the DT pickers");

await tap("Outward");
await tap("DL1LAH6369");
await page.waitForTimeout(300);
await shoot("newtrip-filled", "same screen with direction and vehicle chosen");

// The scanner, and then the close screen with a completeness gap.
const start = page.getByRole("button", { name: /Start scanning/i }).first();
if (await start.count() && await start.isEnabled()) {
  await tap("Kartik");
  await start.click().catch(() => {});
  await page.waitForTimeout(1800);
  await shoot("scan", "the scanner — camera unavailable in this harness");
  await tap("Done");
  await page.waitForTimeout(1200);
  await shoot("closetrip", "closing a trip");
}

const settings = page.locator(".gtopbar button, .gbar button").last();
if (await settings.count()) { await settings.click().catch(() => {}); await page.waitForTimeout(600); }
await shoot("last", "wherever that landed");

console.log(`\n${shots.length} shots\n`);
await browser.close();
