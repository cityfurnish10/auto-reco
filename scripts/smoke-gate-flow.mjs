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
  // SERVICE WORKERS OFF FOR THE WALKTHROUGH, and the reason is the harness, not
  // the app. This test stubs the server at the network boundary with ctx.route.
  // public/sw.js calls skipWaiting + clients.claim, so it takes control of the
  // page MID-LOAD — and once it does, requests pass through it and Playwright's
  // routes no longer see them. The first run after adding the worker proved it:
  // the roster (fetched before control) was stubbed, the PIN check (after
  // control) reached the real server, got a 401 for the fake token, and every
  // step from check-in on failed with "Wrong PIN".
  //
  // On a real phone the worker steps aside for /api/ and the request reaches the
  // server with a real token, so nothing here is hiding a product bug. What the
  // worker actually does — open the app with no network — is tested on its own
  // below, in a context where it is allowed to run.
  serviceWorkers: "block",
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
// The guard is not asked to manage sending. Sync is automatic — on open, on
// return, on reconnect, every 20s — so the old "N saved here, not sent yet /
// Try sending now" panel is gone from Today. Checked here, while Today is the
// screen in front of us.
if (await seen("Start trip")) {
  const panel = await page.locator(".gsyncbox").count();
  const sendBtn = await page.getByRole("button", { name: /send now|try sending/i }).count();
  if (panel === 0 && sendBtn === 0) ok("Today has no sync panel or send button");
  else bad("Today still shows the sync panel — the guard is being asked to manage sending");
}
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

// "CHANGE" MUST REOPEN THE LIST. It did nothing on every iPhone: the pickers sat
// inside a <label>, and WebKit forwarded the tap AFTER the handler had opened
// the list — onto the first option, the vehicle already chosen, which closed it
// again. Chromium does not forward in that case, so only this engine shows it.
await page.waitForTimeout(600);
await page.locator(".gpickchosen").first().getByText("Change").click();
await page.waitForTimeout(700);
if (await page.locator(".gpicklist").count()) {
  ok("tapping Change on the vehicle reopens its list");
  await tap("HR26DK8337");
  await page.waitForTimeout(700);
  if ((await page.locator(".gpickchosen.on").count()) === 2) ok("re-choosing collapses it again, agent kept");
  else bad("after Change and re-choosing, the form is not back to two chosen rows");
} else bad("tapping Change on the vehicle does nothing — the list did not reopen");

// THE GUARD IS NEVER SHOWN WHAT IS EXPECTED, and the stub deliberately
// supplies a full planned load — customer, address, units — so this proves the
// app declines to render data it genuinely has. The gate is only worth having
// because it is an independent witness; show a guard the list and they scan
// against the list, and the record becomes a confirmation of what the other
// systems already believed.
const leaked = [];
for (const secret of ["Planned on this vehicle", "A Sharma", "44 Golf Course Road",
                      "FUMY5U23080048", "Queen Bed"]) {
  if (await seen(secret)) leaked.push(secret);
}
if (leaked.length === 0) ok("the truck's planned load is NOT shown to the guard");
else bad(`the app leaked expectation data to the guard: ${leaked.join(", ")}`);

// And the agent is chosen, never filled in from the truck.
const agentRow = await page.locator(".gpickchosen.on").allInnerTexts();
if (agentRow.some((t) => /Ramesh Kumar/.test(t))) ok("the agent is the one the guard picked");

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
  const rq = indexedDB.open("gate-outbox");
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
    const rq = indexedDB.open("gate-outbox");
    rq.onsuccess = () => {
      const r = rq.result.transaction("items", "readonly").objectStore("items").getAll();
      r.onsuccess = () => res(r.result.map((i) => ({ kind: i.kind, id: i.payload.clientScanId })));
      r.onerror = () => res([]);
    };
    rq.onerror = () => res([]);
  }));

  // Voids QUEUED or already SENT. Counting only queued ones passed for months
  // because a sent void was never cleared from the phone (the stuck-queue bug);
  // with that fixed, a void leaves promptly and has to be read off the wire.
  const voided = new Set([
    ...state.filter((i) => i.kind === "void").map((i) => i.id),
    ...posted.flatMap((b) => (b.voids ?? []).map((v) => v.clientScanId)),
  ]);
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
      const rq = indexedDB.open("gate-outbox");
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

// THE CHECK RUNS, AND THE GUARD NEVER SEES IT.
//
// The stub supplies a three-line picking of which only one survives, so the app
// genuinely HAS a gap to report — which is what makes this worth asserting. It
// still records the gap for a manager; it must simply not put it on the phone.
// Show a guard what is missing and they will go and find it, which sounds
// helpful and means the gate record is no longer an independent observation.
step("The completeness check stays off the phone");
const onPhone = [];
for (const secret of ["Still on the plan", "Against the plan", "Ergonomic Chair",
                      "12 MG Road", "planned item"]) {
  if (await seen(secret)) onPhone.push(secret);
}
if (onPhone.length === 0) ok("nothing about the plan is shown at trip close");
else bad(`the close screen leaked expectation data: ${onPhone.join(", ")}`);
if ((await page.locator(".gmissrow").count()) === 0) ok("no missing-items list is rendered");
else bad("a missing-items list is on the close screen");

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

/* ── 7. Offline, mid-scan ─────────────────────────────────────────────── */
//
// THE CASE THIS APP EXISTS FOR. A gate with no signal must keep recording;
// losing a movement because the wifi dropped is the failure the paper register
// already has. So the requirement is narrow and strict: scanning keeps working,
// the queue keeps growing, nothing is lost, and the guard is TOLD.
step("Offline while scanning");
// Back to the SCANNER first — the offline bar lives there, next to the
// viewfinder, because that is where a guard's eye is when it matters. The
// walkthrough had wandered off to the manual form by this point.
for (const label of ["Cancel", "Back", "Resume trip"]) {
  const b = page.getByRole("button", { name: new RegExp(`^${label}$`, "i") }).first();
  if (await b.count()) { await b.click().catch(() => {}); await page.waitForTimeout(700); }
}
if (!(await seen("Items scanned"))) {
  const resume = page.getByText("Resume trip", { exact: false }).first();
  if (await resume.count()) { await resume.click().catch(() => {}); await page.waitForTimeout(1000); }
}

await ctx.setOffline(true);
await page.waitForTimeout(1200);

// The app learns about it from the browser's own event.
await page.evaluate(() => window.dispatchEvent(new Event("offline")));
await page.waitForTimeout(700);

if (await seen("No internet")) ok("the scanner says there is no internet");
else bad("nothing tells the guard they are offline");

// And it must be a BAR, not a dialog — a modal over a live scanner with a
// driver waiting is worse than the problem it reports.
const blockingDialog = await page.locator(".gsheet").count();
if (blockingDialog === 0) ok("it does not block the screen with a dialog");
else bad("an offline dialog is covering the scanner");

// The queue must still accept work. Written straight in, as elsewhere in this
// walkthrough, because a headless browser cannot scan a QR.
const queuedBefore = await page.evaluate(() => new Promise((res) => {
  const rq = indexedDB.open("gate-outbox");
  rq.onsuccess = () => {
    const r = rq.result.transaction("items", "readonly").objectStore("items").getAll();
    r.onsuccess = () => res(r.result.length);
    r.onerror = () => res(-1);
  };
  rq.onerror = () => res(-1);
}));
await page.evaluate(() => new Promise((res, rej) => {
  const rq = indexedDB.open("gate-outbox");
  rq.onsuccess = () => {
    const tx = rq.result.transaction("items", "readwrite");
    tx.objectStore("items").put({ clientId: "offline-1", kind: "scan", createdAt: Date.now(),
      attempts: 0, payload: { clientScanId: "offline-1", clientTripId: "ct1",
        barcode: "OFFLINE0000001", entryMethod: "scan", itemKind: "unit", quantity: 1,
        scannedAt: new Date().toISOString() } });
    tx.oncomplete = () => res(true);
    tx.onerror = () => rej(tx.error);
  };
  rq.onerror = () => rej(rq.error);
}));
const queuedAfter = await page.evaluate(() => new Promise((res) => {
  const rq = indexedDB.open("gate-outbox");
  rq.onsuccess = () => {
    const r = rq.result.transaction("items", "readonly").objectStore("items").getAll();
    r.onsuccess = () => res(r.result.length);
    r.onerror = () => res(-1);
  };
  rq.onerror = () => res(-1);
}));
if (queuedAfter > queuedBefore) ok(`work still queues while offline (${queuedBefore} → ${queuedAfter})`);
else bad("the queue would not accept a scan while offline");

// Coming back must drain it by itself — a guard should not have to know to
// press anything.
const postedBefore = posted.length;
await ctx.setOffline(false);
await page.evaluate(() => window.dispatchEvent(new Event("online")));
await page.waitForTimeout(2500);
if (posted.length > postedBefore) ok("reconnecting drains the queue on its own");
else bad("the queue did not drain after reconnecting");
if (!(await seen("No internet"))) ok("the offline warning clears once connected");
else bad("the offline warning is still showing after reconnecting");

/* ── the paths that only break BETWEEN screens ───────────────────────────
   Three faults reported from a real phone, none of which the walkthrough above
   would have caught: every one is about what happens when a guard LEAVES the
   app and comes back, or moves between screens. A single clean pass through the
   happy path never exercises them. */

step("The queue drains on open, not twenty seconds later");
// The bug: sync ran on a 20s interval and nothing else, so opening the app
// showed "N waiting" while apparently doing nothing. Reload with something in
// the outbox and require a sync attempt promptly — not eventually.
await page.evaluate(() => new Promise((res) => {
  const rq = indexedDB.open("gate-outbox");
  rq.onsuccess = () => {
    const tx = rq.result.transaction("items", "readwrite");
    tx.objectStore("items").put({ clientId: "onopen-1", kind: "scan", createdAt: Date.now(),
      payload: { clientScanId: "onopen-1", barcode: "SMOKEOPEN0001", direction: "OUT" } });
    tx.oncomplete = () => res(null);
    tx.onerror = () => res(null);
  };
  rq.onerror = () => res(null);
}));
const beforeOpen = posted.length;
await page.reload({ waitUntil: "domcontentloaded" });
// Deliberately short. The whole point is that it does NOT wait for the timer.
await page.waitForTimeout(4000);
if (posted.length > beforeOpen) ok("it tries to send as soon as the app opens");
else bad("nothing was sent on open — the guard waits on the 20s timer again");

step("It syncs again on coming back to the app");
// Mobile browsers suspend timers in a backgrounded tab, so returning to the app
// is the one moment that must not rely on the interval having ticked.
// Something to send first. An empty queue rightly sends nothing, and this
// check only ever passed because sent closes and sign-outs were never cleared
// and so the queue was never empty.
await page.evaluate(() => new Promise((res) => {
  const rq = indexedDB.open("gate-outbox");
  rq.onsuccess = () => {
    const tx = rq.result.transaction("items", "readwrite");
    tx.objectStore("items").put({ clientId: "onshow-1", kind: "scan", createdAt: Date.now(), attempts: 0,
      payload: { clientScanId: "onshow-1", barcode: "SMOKESHOW0001", direction: "OUT" } });
    tx.oncomplete = () => res(null);
    tx.onerror = () => res(null);
  };
  rq.onerror = () => res(null);
}));
const beforeShow = posted.length;
await page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("pageshow"));
});
await page.waitForTimeout(2500);
if (posted.length > beforeShow) ok("returning to the app triggers a sync");
else bad("coming back to the app does not sync — a pocketed phone stays stale");

step("Nothing already sent stays on the phone");
// THE BUG: a trip close, a sign-out and a removed line are queued under their
// own ids ("<trip>-close", "<shift>-out", a void id), but the server names its
// reply after the trip, shift or scan. The phone removed by the reply's name,
// matched nothing, and kept all three as "not sent" forever — a demo phone
// showed five. The stub above replies exactly as the real server does, by
// record id, so this is the real drain against the real reply shape.
const stuckIds = ["smoke-trip-close", "smoke-shift-out", "smoke-void"];
const queued = () => page.evaluate((ids) => new Promise((res) => {
  const rq = indexedDB.open("gate-outbox");
  rq.onsuccess = () => {
    const req = rq.result.transaction("items", "readonly").objectStore("items").getAll();
    req.onsuccess = () => res(req.result.filter((i) => ids.includes(i.clientId)).length);
    req.onerror = () => res(-1);
  };
  rq.onerror = () => res(-1);
}), stuckIds);
await page.evaluate(() => new Promise((res) => {
  const rq = indexedDB.open("gate-outbox");
  rq.onsuccess = () => {
    const tx = rq.result.transaction("items", "readwrite");
    const st = tx.objectStore("items");
    const at = new Date().toISOString();
    st.put({ clientId: "smoke-trip-close", kind: "trip", createdAt: Date.now(), attempts: 0,
      payload: { clientTripId: "smoke-trip", direction: "OUT", vehicleNo: "HR26DK8337",
                 openedAt: at, closedAt: at, status: "closed" } });
    st.put({ clientId: "smoke-shift-out", kind: "shift", createdAt: Date.now(), attempts: 0,
      payload: { clientShiftId: "smoke-shift", checkedInAt: at, checkedOutAt: at, status: "closed" } });
    st.put({ clientId: "smoke-void", kind: "void", createdAt: Date.now(), attempts: 0,
      payload: { clientScanId: "smoke-scan", reason: "smoke", voidedAt: at } });
    tx.oncomplete = () => res(null);
    tx.onerror = () => res(null);
  };
  rq.onerror = () => res(null);
}));
const seeded = await queued();
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
const left = await queued();
if (seeded === 3 && left === 0) ok("a close, a sign-out and a removal leave the queue once the server has them");
else bad(`queued ${seeded}, still on the phone after syncing: ${left} — they will show as "not sent" forever`);

step("Signing out actually signs you out");
// The bug: settings' back button went to the PIN pad, which after a sign-out
// belongs to nobody — and reads as still being signed in.
// Signed out = no guard AND no shift. The walkthrough above left a shift open, so
// both are cleared here, exactly the state handOver() leaves behind.
onShift = false;
await page.evaluate(() => localStorage.removeItem("gate.guardId"));
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);

// The first version of this step passed WITHOUT testing anything: a vague
// "last button with an icon" selector missed the gear, so it fell through to an
// "also acceptable" branch and reported success. A test that cannot fail on the
// regression it guards is worse than no test. So: real labels, and no escape.
if (!(await seen("Who is on duty"))) {
  bad("did not reach the guard list after signing out — cannot test the back button");
} else {
  const gear = page.getByRole("button", { name: "Settings", exact: true }).first();
  if (!(await gear.count())) {
    bad("no Settings button on the guard list — the path under test is unreachable");
  } else {
    await gear.click();
    await page.waitForTimeout(900);
    const back = page.getByRole("button", { name: "Back", exact: true }).first();
    if (!(await back.count())) {
      bad("settings opened but has no Back button");
    } else {
      await back.click();
      await page.waitForTimeout(900);
      // "Enter PIN" is the bug: a keypad for a guard nobody selected, which reads
      // as still being signed in.
      if (await seen("Enter PIN")) bad("back from settings lands on the PIN pad after signing out");
      else if (await seen("Who is on duty")) ok("back from settings returns to the guard list, not the PIN pad");
      else bad("back from settings went somewhere unexpected");
    }
  }
}

step("A phone that loses its pairing does not lose its work");
// Three safeguards, each covering what the one before cannot:
//   1. the pairing is kept BESIDE the queue in IndexedDB as well as localStorage,
//      so browser clean-up cannot take the pairing and strand the work;
//   2. the app asks the browser to keep this storage (not observable headless);
//   3. if the pairing is lost anyway, the phone says work is waiting, sends
//      nothing without a pairing, and sends it all once paired again.
// Every assertion here fails against the code before this change.
{
  // The walkthrough's first init script re-seeds the token on every load; this
  // one removes it again while the flag is set — how "the browser cleared
  // localStorage" is faked. Init scripts run in the order they were added.
  await ctx.addInitScript(() => {
    try { if (localStorage.getItem("__smoke_unpair") === "1") localStorage.removeItem("gate.deviceToken"); }
    catch { /* blocked */ }
  });
  const sentStranded = () =>
    posted.some((b) => (b.scans ?? []).some((x) => x.clientScanId === "stranded-1"));

  // ── safeguard 1: localStorage gone, IndexedDB intact → still paired ─────
  await page.evaluate(() => localStorage.setItem("__smoke_unpair", "1"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  if (await seen("not paired")) bad("clearing localStorage unpaired the phone — the pairing is not kept beside the queue");
  else ok("with localStorage cleared, the pairing survives beside the queue");

  // ── safeguard 3: pairing gone from BOTH, work still queued ───────────────
  await page.evaluate(() => new Promise((res) => {
    const rq = indexedDB.open("gate-outbox");
    rq.onsuccess = () => {
      try {
        const tx = rq.result.transaction("meta", "readwrite");
        tx.objectStore("meta").delete("gate.deviceToken");
        tx.oncomplete = () => res(true); tx.onerror = () => res(false);
      } catch { res(false); }  // no meta store on the old code — nothing to delete
    };
    rq.onerror = () => res(false);
  }));
  // Reload FIRST, so the phone is unpaired before any work exists — otherwise the
  // still-paired page in memory could send it and fake a result either way.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.evaluate(() => new Promise((res) => {
    const rq = indexedDB.open("gate-outbox");
    rq.onsuccess = () => {
      const tx = rq.result.transaction("items", "readwrite");
      tx.objectStore("items").put({ clientId: "stranded-1", kind: "scan", createdAt: Date.now(), attempts: 0,
        payload: { clientScanId: "stranded-1", barcode: "SMOKESTRAND01", direction: "OUT" } });
      tx.oncomplete = () => res(null); tx.onerror = () => res(null);
    };
    rq.onerror = () => res(null);
  }));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  if (!(await seen("not paired"))) {
    bad("with the pairing gone from both copies, the phone did not say it is unpaired");
  } else if (await seen("Your work is saved on this phone")) {
    ok("the unpaired screen says saved work is still waiting");
  } else {
    bad("the unpaired screen hides that work is still waiting on the phone");
  }
  if (sentStranded()) bad("an unpaired phone tried to send its queue with no pairing");
  else ok("nothing is sent while the phone has no pairing");

  // ── recovery: paired again → the work that WAITED is sent ─────────────────
  // "It was sent" is not enough on its own. The old code also sent it — early,
  // while unpaired, with an empty token — so a bare "sent at some point" check
  // PASSED against the old code for the wrong reason (caught by running this
  // step against the pre-change app). The real claim is HELD, THEN SENT: no send
  // before pairing, at least one after. That fails on the old code whether or
  // not it happens to resend later.
  const pairedAt = posted.length;
  await page.evaluate(() => localStorage.removeItem("__smoke_unpair"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  const firstSend = posted.findIndex((b) =>
    (b.scans ?? []).some((x) => x.clientScanId === "stranded-1"));
  if (firstSend >= pairedAt) ok("the work that waited was held until paired, then sent");
  else if (firstSend === -1) bad("after pairing again, the work that waited was never sent");
  else bad("the waiting work was sent before the phone was paired — not held for it");
}

step("The app opens with no network (service worker)");
// The one thing public/sw.js exists to do. Its own context, workers ALLOWED,
// and NO device token on purpose: without a token the app shows the unpaired
// screen straight from the shell with no API call, so this proves the worker
// served the app offline without depending on any stubbed request — exactly the
// kind the walkthrough above had to switch the worker off to keep.
{
  const swCtx = await browser.newContext({
    viewport: { width: 390, height: 844 }, serviceWorkers: "allow",
  });
  const swPage = await swCtx.newPage();
  try {
    await swPage.goto(`${BASE}/scan`, { waitUntil: "load", timeout: 45_000 });
    // Registration happens after load; give it time to install and claim.
    const controlled = await swPage.waitForFunction(
      () => !!navigator.serviceWorker && !!navigator.serviceWorker.controller,
      null, { timeout: 15_000 }).then(() => true).catch(() => false);
    if (controlled) ok("the service worker registers and takes control of /scan");
    else bad("no service worker controls /scan — the app cannot open offline");

    // One more online load so the build chunks are fetched THROUGH the worker
    // and land in its cache.
    await swPage.reload({ waitUntil: "load" });
    await swPage.waitForTimeout(2500);

    await swCtx.setOffline(true);
    await swPage.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await swPage.waitForTimeout(3000);
    const offlineText = (await swPage.locator("body").innerText().catch(() => "")).trim();
    if (/not paired|Gate Check/i.test(offlineText)) ok("with the network gone, the app still opens");
    else bad(`offline reload did not render the app — got: "${offlineText.replace(/\s+/g, " ").slice(0, 80)}"`);

    // And the dashboard must NOT be served from cache — stale figures that look
    // current are the failure the portal was fixed for.
    const dash = await swPage.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded", timeout: 8_000 })
      .then(() => "loaded").catch(() => "failed");
    if (dash === "failed") ok("the dashboard is not served from the cache while offline");
    else bad("the dashboard loaded offline — the service worker is caching it");
  } finally {
    await swCtx.close();
  }
}

/* ── report ──────────────────────────────────────────────────────────── */
step("Result");
const uniq = [...new Set(errors)].filter((e) =>
  !/favicon|models\/face|getUserMedia|Permission/i.test(e) &&
  // This walkthrough takes the network away deliberately; the browser
  // complaining about it is the test working, not a defect.
  !/Failed to load resource|internal error|Load failed|NetworkError/i.test(e));
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
