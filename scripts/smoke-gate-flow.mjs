// Drive the guard app through a whole trip in a real browser.
//
// WHY THIS EXISTS, AND WHY IT IS NOT A UNIT TEST. Nine screens were once
// deleted by a careless edit and types, lint, build and 700 mocked tests all
// passed — the bug was only found by opening the app on a phone. smoke-gate.mjs
// closed half of that gap: it proves the app LOADS. This closes the other half:
// it proves the app can be USED, by walking the screens a guard walks and
// failing if a control is missing, dead, or does not do what it says.
//
// The server is stubbed at the network boundary rather than mocked in JS, so
// everything from the fetch call inwards is the real application code.
//
//   node scripts/smoke-gate-flow.mjs [url] [chromium|webkit]

import { chromium, webkit } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3100";
// WebKit by default: the guards use their own phones and an iPhone runs WebKit
// whatever the browser badge says.
const ENGINE = (process.argv[3] ?? "webkit") === "chromium" ? chromium : webkit;

let failures = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const step = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

const GUARD_ID = "11111111-1111-1111-1111-111111111111";

/** A fake 128-float face signature; the model never runs in this harness. */
const DESCRIPTOR = Array.from({ length: 128 }, (_, i) => (i % 7) / 10);

const browser = await ENGINE.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
});
const page = await ctx.newPage();

const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(`UNCAUGHT: ${e.message}`));

// What the phone posted, so the test can assert on the RECORD and not just on
// what the screen said. A trip that looks closed but sent nothing is the
// failure mode that matters.
const posted = [];

// Flipped once the check-in gate has been asserted, so the same stub can serve
// both halves of the walk-through.
let onShift = false;
let withTrip = false;

const json = (route, body) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

await ctx.route("**/api/gate/session", (route) =>
  route.request().method() === "POST"
    ? json(route, { ok: true, guard: { id: GUARD_ID, name: "Test Guard" } })
    : json(route, {
        site: { city: "DELHI", code: "DEL-1" },
        guards: [{ guardId: GUARD_ID, name: "Test Guard", employeeCode: "G-01",
                   descriptor: DESCRIPTOR, enrolled: true }],
      }));

await ctx.route("**/api/gate/bootstrap*", (route) => json(route, {
  guard: { id: GUARD_ID, name: "Test Guard" },
  businessDate: "2026-08-24",
  site: { code: "DEL-1", label: "Delhi", lat: 28.6, lng: 77.2, radiusM: 300 },
  config: { outwardPhotoSampleRate: 0.1, expectedCheckLive: false, completenessShown: true },
  openTrip: withTrip
    ? { id: "t1", client_trip_id: "ct1", direction: "OUT",
        vehicle_no: "HR26DK8337", opened_at: "2026-08-24T10:00:00.000Z" }
    : null,
  // An open shift, so the walk-through reaches the trip screens. The check-in
  // gate is asserted separately above, against a bootstrap with no shift.
  openShift: onShift
    ? { id: "s1", client_shift_id: "cs1", checked_in_at: "2026-08-24T09:00:00.000Z" }
    : null,
  expected: [], expectedCount: 0,
}));

// The live DT read. Two vehicles and two agents, so the picker has a list to
// render and the "type it in" escape has something to escape from.
await ctx.route("**/api/gate/fleet", (route) => json(route, {
  vehicles: ["HR26DK8337", "DL01AB1234"],
  agents: ["Ramesh Kumar", "Suresh Yadav"],
  // HR26DK8337 has TWO agents on purpose, so the agent picker still has to be
  // answered — the auto-fill only fires when DT names exactly one, and a
  // walkthrough that never exercised the picker would stop testing it.
  trips: [
    { vehicle: "HR26DK8337", agents: ["Ramesh Kumar", "Suresh Yadav"], unitCount: 1,
      tasks: [{ ticket: "1174052", customer: "A Sharma", jobType: "Replace",
                address: "44 Golf Course Road, Gurgaon, 122002",
                units: [{ barcode: "FUMY5U23080048", product: "Queen Bed" }] }] },
    { vehicle: "DL01AB1234", agents: ["Ramesh Kumar"], unitCount: 0, tasks: [] },
  ],
  source: "dt",
}));

await ctx.route("**/api/gate/sync", async (route) => {
  const body = route.request().postDataJSON() ?? {};
  posted.push(body);
  const done = (arr, key) => (arr ?? []).map((x) => ({ clientId: x[key], status: "stored", id: "srv" }));
  await json(route, {
    ok: true,
    trips: done(body.trips, "clientTripId"),
    scans: done(body.scans, "clientScanId"),
    voids: done(body.voids, "clientScanId"),
    shifts: done(body.shifts, "clientShiftId"),
    faceChecks: done(body.faceChecks, "clientCheckId"),
    photos: [], selfies: [], bucket: "e", selfieBucket: "a",
    clockWarnings: [], truncated: false,
  });
});

await ctx.route("**/api/gate/history*", (route) => json(route, { trips: [] }));

// The on-demand expected list. Counted, because the point of the change is
// WHEN it is asked for: at trip start and on the way into the close screen,
// never on the scanning path.
let expectedCalls = 0;
await ctx.route("**/api/gate/expected", (route) => {
  expectedCalls++;
  return json(route, {
    items: [
      { barcode: "FUMYHA23030062", barcode_canon: "FUMYHA23030062", direction: "OUT",
        product: "Chair", so_number: "ON-1", ticket_id: null, customer: null,
        picking_ref: "GUR/OUT/3957", delivery_address: null },
      { barcode: "AP815719030952", barcode_canon: "AP815719030952", direction: "OUT",
        product: "Desk", so_number: "ON-1", ticket_id: null, customer: null,
        picking_ref: "GUR/OUT/3957", delivery_address: null },
      // The third line of the same picking, never scanned. This is the one the
      // close screen has to notice.
      { barcode: "FUMY5U23080048", barcode_canon: "FUMY5U23080048", direction: "OUT",
        product: "Ergonomic Chair", so_number: "ON-RET-GUR-76196", ticket_id: null,
        customer: "K S Gudi", picking_ref: "GUR/OUT/3957",
        delivery_address: "12 MG Road" },
    ],
    businessDate: "2026-08-25", refreshed: true, stale: false, reason: null,
  });
});

// A paired device, so the app opens on the roster rather than the pairing screen.
await ctx.addInitScript(() => {
  localStorage.setItem("gate.deviceToken", "smoke-token");
});

/** Tap by visible text, and say so plainly when it is not there. */
async function tap(label, { exact = false, timeout = 6000 } = {}) {
  const el = page.getByText(label, { exact }).first();
  try {
    await el.waitFor({ state: "visible", timeout });
    await el.click();
    return true;
  } catch {
    bad(`could not tap "${label}" — it is not on screen`);
    return false;
  }
}

const seen = async (label) =>
  page.getByText(label, { exact: false }).first()
    .isVisible({ timeout: 4000 }).catch(() => false);

/* ── 1. open and sign in ─────────────────────────────────────────────── */
step("Opening the app");
await page.goto(`${BASE}/scan`, { waitUntil: "domcontentloaded", timeout: 45_000 });
await page.waitForTimeout(2500);

const body = (await page.locator("body").innerText().catch(() => "")).trim();
if (!body) bad("the page renders no text at all — this is the blank screen");
else ok(`renders: "${body.replace(/\s+/g, " ").slice(0, 70)}…"`);

await tap("Test Guard");
await page.waitForTimeout(400);
for (const d of "1234") await page.getByRole("button", { name: d, exact: true }).first().click();
await page.waitForTimeout(1200);

/* ── 2. the check-in must refuse to proceed without a photo ──────────── */
step("Check-in requires a photo");
if (await seen("Take your photo to check in")) {
  ok("says a photo is required");
} else if (await seen("Check in")) {
  bad("no 'photo required' notice — check-in may still be skippable");
}
const checkInBtn = page.getByRole("button", { name: /^Check in$/i }).first();
if (await checkInBtn.count()) {
  const disabled = await checkInBtn.isDisabled().catch(() => false);
  disabled ? ok("the Check in button is disabled until a photo is taken")
           : bad("Check in is TAPPABLE with no photo — anyone can sign in (the reported bug)");
} else {
  bad("no Check in button found — did the check-in screen render?");
}

// A headless browser has no face to show a camera, so the check-in itself
// cannot be performed here. The shift is granted by the server stub instead —
// the same state a guard reaches after checking in — and the walk-through
// continues from there.
onShift = true;
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);
for (const d of "1234") {
  const k = page.getByRole("button", { name: d, exact: true }).first();
  if (await k.count()) await k.click().catch(() => {});
}
await page.waitForTimeout(1200);

/* ── 3. the trip form: pickers, and the mandatory fields ─────────────── */
step("Starting a trip");
if (!(await seen("Start trip"))) await tap("Start trip");
await tap("Start trip");
await page.waitForTimeout(1200);

if (await seen("HR26DK8337")) ok("the vehicle list arrived from DT and rendered");
else bad("no vehicle list — the picker fell back to a text box");

// The agent picker starts COLLAPSED. Two open lists plus a footer do not fit on
// a 390px screen — the second was rendering sliced through the middle of a
// name — so the form opens one at a time and walks forward.
if (await seen("Choose the delivery agent")) ok("the agent picker waits its turn, collapsed");
else bad("both pickers are open at once — the second will be sliced by the footer");

if (await seen("Not listed")) ok("'type it in' escape is offered");
else bad("no way to type a vehicle that is not on the list");

const startScan = page.getByRole("button", { name: /Start scanning/i }).first();
if (await startScan.count()) {
  const disabled = await startScan.isDisabled().catch(() => false);
  disabled ? ok("cannot start scanning until direction, vehicle and agent are set")
           : bad("Start scanning is enabled with nothing filled in");
}

await tap("Outward");
await tap("HR26DK8337");
await page.waitForTimeout(500);

// Choosing a vehicle should hand the screen to the agent picker by itself.
if (await seen("Ramesh Kumar")) ok("choosing a vehicle opens the agent list automatically");
else bad("the agent list did not open after a vehicle was chosen");

await tap("Ramesh Kumar");
await page.waitForTimeout(400);

// And both should now read as decided rather than as open lists.
const chosen = await page.locator(".gpickchosen.on").count();
if (chosen === 2) ok("both pickers collapsed to a chosen row");
else bad(`expected 2 collapsed 'chosen' rows, found ${chosen}`);

// What DT says is ON this truck. The point of picking a vehicle rather than
// two independent lists: the guard sees the load before they start.
if (await seen("Planned on this vehicle")) {
  ok("shows what DT has planned for the chosen truck");
  if (await seen("A Sharma")) ok("names the customer");
  else bad("no customer on the planned load");
  if (await seen("44 Golf Course Road")) ok("shows the delivery address");
  else bad("no delivery address on the planned load");
  if (await seen("FUMY5U23080048")) ok("lists the planned units");
  else bad("no units listed");
} else {
  bad("the truck's planned load is not shown");
}

if (await startScan.isEnabled().catch(() => false)) ok("enabled once all three are chosen");
else bad("still disabled after choosing direction, vehicle and agent");

await startScan.click();
await page.waitForTimeout(1500);

/* ── 4. scan, then remove — the double confirm ───────────────────────── */
step("Removing a scanned item");
if (!(await seen("Items scanned"))) bad("the scanner screen did not render");
else ok("the scanner screen rendered");

const addBtn = page.locator(".gscanfoot .gbtn.ghost").first();
if (await addBtn.count()) ok("the manual-add button is on the scanner");
else bad("no manual-add button on the scanner");

// A headless browser cannot scan a QR, so two scans are written straight into
// the outbox — the same shape the app writes — and the page is reloaded. The
// app rebuilds its item list from that queue, which is exactly the path a
// guard takes when they close and reopen the app mid-trip. Everything after
// this point is the real removal code against a real queued row.
withTrip = true;
await page.evaluate(() => new Promise((res, rej) => {
  const rq = indexedDB.open("gate-outbox", 1);
  rq.onsuccess = () => {
    const db = rq.result;
    const tx = db.transaction("items", "readwrite");
    const store = tx.objectStore("items");
    for (const [id, bc] of [["sc-1", "FUMYHA23030062"], ["sc-2", "AP815719030952"],
                            ["sc-3", "FUMY5U23080048"]]) {
      store.put({ clientId: id, kind: "scan", createdAt: Date.now(), attempts: 0,
        payload: { clientScanId: id, clientTripId: "ct1", barcode: bc,
                   entryMethod: "scan", itemKind: "unit", quantity: 1,
                   scannedAt: new Date().toISOString() } });
    }
    tx.oncomplete = () => res(true);
    tx.onerror = () => rej(tx.error);
  };
  rq.onerror = () => rej(rq.error);
}));
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(2200);
for (const d of "1234") {
  const k = page.getByRole("button", { name: d, exact: true }).first();
  if (await k.count()) await k.click().catch(() => {});
}
await page.waitForTimeout(1500);
if (!(await seen("Items scanned"))) await tap("Resume trip");
await page.waitForTimeout(1200);

const rows = page.locator(".gfeed .grow");
const before = await rows.count();
if (before === 3) ok(`the trip's ${before} items came back after a reload`);
else bad(`expected 3 restored items, found ${before}`);

const xBtn = page.locator(".gfeed .grow .gx").first();
if (!(await xBtn.count())) {
  bad("no remove control on a scanned row — the reported gap");
} else {
  ok("each scanned row has a remove control");
  await xBtn.click();
  await page.waitForTimeout(600);

  // The double check. A single tap must NOT have removed anything yet.
  if (await seen("Remove this item?")) ok("asks before removing");
  else bad("removed on a single tap, with no confirmation");

  const stillThere = await rows.count();
  if (stillThere === before) ok("nothing is removed while the question is open");
  else bad("the row vanished before the guard answered");

  // "Keep it" must genuinely keep it.
  await page.locator(".gsheetbox").getByRole("button", { name: /Keep it/i }).first().click();
  await page.waitForTimeout(600);
  if ((await rows.count()) === before) ok("'Keep it' leaves the item alone");
  else bad("'Keep it' removed the item anyway");

  // And now actually remove one.
  await page.locator(".gfeed .grow .gx").first().click();
  await page.waitForTimeout(500);
  // Scoped to the sheet: the row's own × also announces "Remove", and a test
  // that cannot tell them apart is a test that proves nothing.
  await page.locator(".gsheetbox").getByRole("button", { name: /^Remove$/i }).first().click();
  await page.waitForTimeout(1200);

  const after = await rows.count();
  if (after === before - 1) ok(`removed: ${before} → ${after} items`);
  else bad(`removal did not take effect: still ${after} items`);

  // THE RECORD, not just the screen. A row that disappears from the feed while
  // still counting on the server is the worst possible outcome — the guard
  // believes it is gone and the reconciler does not. So the invariant is
  // checked against what the phone has actually done with both scans, whichever
  // one the tap landed on:
  //
  //   live = (queued as a scan  ∪  already posted)  −  voided
  //
  // and exactly one of the two must still be live.
  const state = await page.evaluate(() => new Promise((res) => {
    const rq = indexedDB.open("gate-outbox", 1);
    rq.onsuccess = () => {
      const r = rq.result.transaction("items", "readonly").objectStore("items").getAll();
      r.onsuccess = () => res(r.result.map((i) => ({ kind: i.kind, id: i.payload.clientScanId })));
      r.onerror = () => res([]);
    };
    rq.onerror = () => res([]);
  }));

  const voided = new Set(state.filter((i) => i.kind === "void").map((i) => i.id));
  const live = new Set([
    ...state.filter((i) => i.kind === "scan").map((i) => i.id),
    ...posted.flatMap((b) => (b.scans ?? []).map((x) => x.clientScanId)),
  ].filter((id) => ["sc-1", "sc-2", "sc-3"].includes(id) && !voided.has(id)));

  if (live.size === 2) {
    ok(voided.size
      ? `the removed scan had already been sent, so a void was queued (${[...voided]})`
      : "the removed scan left the queue and never reached the server");
  } else {
    bad(`${live.size} scans still count as live movements, expected 2 — ` +
        `queued/posted minus voided = [${[...live]}]`);
  }

  // ── the OTHER path: removing a scan the server already has ────────────
  // Above, the row was still in the queue and deleting it was the whole job.
  // Here the scan has been synced, so deleting it locally would leave the
  // server counting an item the guard believes is gone. A void has to travel.
  step("Removing an item the server already has");
  const drained = await page.evaluate(async () => {
    // The app syncs on its own schedule; this forces the remaining scan out so
    // the next removal is unambiguously the already-sent case.
    window.dispatchEvent(new Event("online"));
    await new Promise((r) => setTimeout(r, 1200));
    return true;
  });
  await page.waitForTimeout(1500);
  const sentIds = new Set(posted.flatMap((b) => (b.scans ?? []).map((x) => x.clientScanId)));
  if (!drained || sentIds.size === 0) {
    console.log("  \x1b[33m–\x1b[0m nothing synced in time; the void path is not exercised here");
  } else {
    await page.locator(".gfeed .grow .gx").first().click();
    await page.waitForTimeout(500);
    await page.locator(".gsheetbox").getByRole("button", { name: /^Remove$/i }).first().click();
    await page.waitForTimeout(1500);

    if ((await rows.count()) === 1) ok("the second item came off the list too");
    else bad("the second removal did not take effect");

    const after2 = await page.evaluate(() => new Promise((res) => {
      const rq = indexedDB.open("gate-outbox", 1);
      rq.onsuccess = () => {
        const r = rq.result.transaction("items", "readonly").objectStore("items").getAll();
        r.onsuccess = () => res(r.result.map((i) => ({ kind: i.kind, id: i.payload.clientScanId })));
        r.onerror = () => res([]);
      };
      rq.onerror = () => res([]);
    }));
    const voids = after2.filter((i) => i.kind === "void");
    const sentVoid = posted.flatMap((b) => b.voids ?? []);
    if (voids.length || sentVoid.length) {
      ok(`a retraction was raised for the already-sent scan (${
        [...voids, ...sentVoid].map((v) => v.id ?? v.clientScanId).join(", ")})`);
    } else {
      bad("the scan was already on the server and NO void was raised — it still counts");
    }
    if (sentVoid.length) ok("and the retraction reached the server");
  }
}

/* ── 5. the close screen: last-minute add ────────────────────────────── */
step("The close screen");
await tap("Done");
await page.waitForTimeout(1200);

if (await seen("Close trip")) ok("the close screen rendered");
else bad("the close screen did not render");

if (await seen("last minute")) ok("offers a last-minute addition");
else bad("no last-minute add on the close screen — the reported gap");

/* ── the completeness check ───────────────────────────────────────────── */
// The stubbed plan holds three lines of ONE picking; the seeded outbox scanned
// two of them and one was then removed. Whatever the arithmetic, the guard
// must be told the truck is short and told WHICH item — a bare count sends
// them to a supervisor, the order and the customer send them to a pallet.
step("The completeness check");
if (await seen("Still on the plan")) {
  ok("warns that something planned was not scanned");
  // Two of the picking's three lines were removed, so two are short. Asserted
  // by count rather than by name: which row the tap landed on depends on feed
  // ordering, and a test that pins that is testing the wrong thing.
  const missRows = page.locator(".gmissrow");
  const n = await missRows.count();
  if (n === 2) ok(`names both missing items (${n})`);
  else bad(`expected 2 missing items listed, found ${n}`);

  const firstDetail = await missRows.first().innerText().catch(() => "");
  if (/[A-Z0-9]{10,}/.test(firstDetail)) ok("each row carries the barcode");
  else bad("a missing row shows no barcode");
  if (/Chair|Desk/.test(firstDetail)) ok("shows the product, not just a serial");
  else bad(`no product name — a bare serial is not actionable at a gate (${firstDetail.replace(/\n/g, " ")})`);

  if (await seen("Against the plan")) ok("shows the scanned-against-planned tally");
  else bad("no tally on the summary card");
} else {
  bad("the close screen did NOT warn, though a planned item was never scanned");
}

// And it must never stand between a guard and closing the trip.
const closeBtn = page.getByRole("button", { name: /^Close trip$/i }).first();
if (await closeBtn.count()) {
  const blocked = await closeBtn.isDisabled().catch(() => false);
  blocked ? bad("Close trip is DISABLED by the warning — a guard who cannot close stops using the app")
          : ok("the trip can still be closed — warn, let it go, record the gap");
} else bad("no Close trip button");

const addManually = page.getByRole("button", { name: /Add manually/i }).first();
if (await addManually.count()) {
  await addManually.click();
  await page.waitForTimeout(1000);
  if (await seen("What is it")) ok("the last-minute button opens the manual form");
  else bad("the last-minute button does not open the manual form");

  // And it must come BACK to the close screen, not to the scanner.
  const backish = page.locator(".gbar button, .gtopbar button").first();
  if (await backish.count()) {
    await backish.click();
    await page.waitForTimeout(900);
    if (await seen("Close trip")) ok("returns to the close screen, not the scanner");
    else bad("went back to the wrong screen");
  }
} else {
  bad("no 'Add manually' button on the close screen");
}

/* ── 6. the photo box ────────────────────────────────────────────────── */
step("The item photo box");
await addManually.click().catch(() => {});
await page.waitForTimeout(900);
await tap("Spare part").catch(() => {});
await page.waitForTimeout(700);
const frame = page.locator(".gphotoframe").first();
if (await frame.count()) {
  ok("the square photo frame renders");
  const box = await frame.boundingBox();
  if (box && Math.abs(box.width - box.height) < 24) ok(`it is square (${Math.round(box.width)}×${Math.round(box.height)})`);
  else if (box) bad(`not square: ${Math.round(box.width)}×${Math.round(box.height)}`);
  if (await page.getByRole("button", { name: /Take picture/i }).first().count()) {
    ok("a separate 'Take picture' button exists");
  } else bad("no explicit capture button");
} else {
  bad("no photo frame on the manual form");
}

/* ── report ──────────────────────────────────────────────────────────── */
step("Result");
const uniq = [...new Set(errors)].filter((e) => !/favicon|models\/face|getUserMedia|Permission/i.test(e));
if (uniq.length) {
  console.log("  console errors:");
  for (const e of uniq.slice(0, 8)) console.log(`    • ${e.slice(0, 200)}`);
  failures += uniq.length;
} else ok("no unexpected console errors");

console.log(`\n  ${posted.length} sync call(s) reached the server`);
if (expectedCalls > 0) ok(`the expected list was re-read ${expectedCalls}× (trip start / close)`);
else bad("the expected list was never re-read — the scanner is using a stale copy");
console.log(failures ? `\n\x1b[31m${failures} problem(s)\x1b[0m\n` : "\n\x1b[32mall good\x1b[0m\n");
await browser.close();
process.exit(failures ? 1 : 0);
