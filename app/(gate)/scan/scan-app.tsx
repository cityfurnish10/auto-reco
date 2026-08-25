"use client";

// The guard app.
//
// ONE component with screen state rather than routed pages: at a gate, a route
// transition is a blank frame and a lost camera stream. The whole flow is
// instant and nothing is dropped when a call comes in mid-trip.
//
// OFFLINE IS THE DEFAULT ASSUMPTION, not an error path. Every action is written
// to the local outbox first and synced whenever the network allows. The screen
// never waits on the server — a guard at a gate cannot stand still while a
// request times out.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/icon";
import { LANGS, makeT, type LangId } from "@/lib/gate/client/i18n";
import * as outbox from "@/lib/gate/client/outbox";
import { bootstrap, clearGuardId, drain, expectedNow, fleet as fetchFleet, getGuardId, getToken,
         history, rosterFor, signIn, type Bootstrap, type ExpectedItem, type Fleet,
         type GuardOption, type HistoryTrip } from "@/lib/gate/client/api";
import { click, compress, feedback, position } from "@/lib/gate/client/media";
import { decodeFrame, initScanner, openCamera, stopCamera } from "@/lib/gate/client/scanner";
import { canonicalize } from "@/lib/engine/barcode";
import { blocksEntry, compare, describe as describeFace, fromArray, initFace } from "@/lib/gate/client/face";
import { assessTrip, type Completeness } from "@/lib/gate/completeness";

type Screen =
  | "loading" | "unpaired" | "who" | "pin" | "checkin" | "today"
  | "newtrip" | "scan" | "resolve" | "manual" | "closetrip" | "settings"
  // The two that decide whether a guard trusts the app when it is not
  // behaving: what went wrong, and what is still waiting to be sent.
  | "problem" | "queue" | "profile" | "history" | "randomcheck";

interface ScanLine {
  clientId: string; barcode: string; label: string; flagged: boolean;
  /** The QR spelling, when there was one. Kept apart from `barcode` above,
   *  which falls back to a serial or a category name for display — removing a
   *  line has to free the EXACT string the duplicate guard is holding, or the
   *  item can never be scanned again on this trip. */
  rawBarcode?: string | null;
}

const uid = () =>
  (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);

const CATS: Record<"IN" | "OUT", [string, string, IconName][]> = {
  IN: [["vendor_goods","catVendor","local_shipping"],["customer_return","catReturn","arrow_down"],
       ["spare_part","catSpare","wrench"],["consumable","catConsum","category"],
       ["pp_box","catPP","package"],["sample","catSample","verified"]],
  OUT:[["spare_part","catSpare","wrench"],["consumable","catConsum","category"],
       ["pp_box","catPP","package"],["sample","catSample","verified"]],
};
const COUNTED = ["spare_part", "consumable", "pp_box", "sample"];
const REASONS = ["rsnDamaged", "rsnLate", "rsnRepair", "rsnOther"];

export default function GateApp() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [lang, setLang] = useState<LangId>("en");
  const [night, setNight] = useState(false);
  const t = makeT(lang);

  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [queue, setQueue] = useState({ waiting: 0, rejected: 0 });
  const [online, setOnline] = useState(true);

  // shift
  const [shiftId, setShiftId] = useState<string | null>(null);
  const [shiftAt, setShiftAt] = useState<string | null>(null);

  // trip
  const [dir, setDir] = useState<"IN" | "OUT" | null>(null);
  const [veh, setVeh] = useState("");
  const [drv, setDrv] = useState("");
  const [tripId, setTripId] = useState<string | null>(null);
  const [lines, setLines] = useState<ScanLine[]>([]);
  // The row a guard has asked to remove, held while they confirm. Removing a
  // movement is the one destructive thing this app can do, so it never happens
  // on a single tap next to a live scanner that is firing every two seconds.
  const [confirmRemove, setConfirmRemove] = useState<ScanLine | null>(null);
  // Which screen the manual-entry form should return to. It used to always go
  // back to the scanner, which was fine while that was the only way in. The
  // close screen is now the second, and it is the one that matters most: the
  // last-minute box goes on the truck AFTER the guard has stopped scanning.
  const [manualFrom, setManualFrom] = useState<"scan" | "closetrip">("scan");

  // Today's trucks and agents, read live from DT. Null while it has not been
  // asked for yet, which is a different state from "asked and found nothing" —
  // the first shows a spinner, the second shows a text box.
  const [fleet, setFleet] = useState<Fleet | null>(null);

  // The expected list the scanner checks against. Seeded from bootstrap and
  // then REPLACED by a fresh read at trip start, because Odoo pickings here are
  // created during the day: a list from when the app opened this morning is
  // most of a shift out of date by the afternoon.
  const [expected, setExpected] = useState<ExpectedItem[] | null>(null);
  const [expectedStale, setExpectedStale] = useState(false);

  /** Pull a current list. Never blocks; keeps the old one if it cannot. */
  const loadExpected = useCallback(async () => {
    const r = await expectedNow();
    if (!r) { setExpectedStale(true); return; }
    setExpected(r.items);
    setExpectedStale(r.stale);
  }, []);
  // Whether the guard has chosen to type instead of pick, per field. Sticky
  // for the trip: someone who has just typed a truck number that is not on the
  // list should not be dropped back into that list for the agent as well.
  const [vehTyped, setVehTyped] = useState(false);
  const [drvTyped, setDrvTyped] = useState(false);

  /**
   * Refresh the fleet.
   *
   * Called on open and again when the trip form is about to be shown, which is
   * the moment the answer has to be current. Never awaited by anything the
   * guard is blocked on — the form renders with whatever it has and fills in.
   */
  const loadFleet = useCallback(async () => {
    const f = await fetchFleet();
    setFleet(f);
  }, []);
  // Persisted, not just held. A guard whose phone dies mid-trip comes back to
  // the same trip; a start time read from memory would restart the clock and
  // report a forty-minute load as four, which reads as plausible and is not.
  const [t0, setT0] = useState(0);
  const [trips, setTrips] = useState(0);
  // Running totals for the day. `lines` is the OPEN trip only and is cleared
  // when it closes, so reading it here showed 0 items the moment a trip ended.
  const [itemsToday, setItemsToday] = useState(0);
  // Derived at the moment a scan lands, not while rendering. Reading the clock
  // during render makes the output depend on WHEN React chose to re-render,
  // which is neither reproducible nor allowed.
  const [rate, setRate] = useState("—");
  const [elapsed, setElapsed] = useState("—");

  // scanner
  const videoRef = useRef<HTMLVideoElement>(null);
  const workRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const loopRef = useRef<number | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const busyRef = useRef(false);
  // The scan loop is started once and lives for the whole screen; keeping the
  // handler in a ref lets it see fresh state without tearing down the camera
  // stream every time that state changes.
  const onDecodedRef = useRef<(v: string) => Promise<void>>(async () => {});
  const [flash, setFlash] = useState<"" | "ok" | "warn">("");
  const [hint, setHint] = useState("");

  // resolve / manual
  const [pendingScan, setPendingScan] = useState<{ barcode: string; label: string } | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [cat, setCat] = useState<string | null>(null);
  const [noSticker, setNoSticker] = useState(false);
  const [mId, setMId] = useState("");
  const [mQty, setMQty] = useState(1);
  const [mNote, setMNote] = useState("");

  const [pin, setPin] = useState("");
  const [pinBad, setPinBad] = useState(false);
  const [problem, setProblem] = useState<{ titleKey: string; bodyKey: string } | null>(null);
  const [histDate, setHistDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [hist, setHist] = useState<{ trips: HistoryTrip[]; totals: { trips: number; items: number } } | null>(null);
  const [histErr, setHistErr] = useState<string | null>(null);
  const [openTripId, setOpenTripId] = useState<string | null>(null);
  // Random in-shift photo checks. Times are drawn ONCE when the shift starts
  // and kept, so reopening the app cannot dodge a prompt by resetting the
  // clock — which would make the whole check optional in practice.
  const [checkTimes, setCheckTimes] = useState<number[]>([]);
  const [screenBefore, setScreenBefore] = useState<Screen>("today");
  const [rejected, setRejected] = useState<outbox.OutboxItem[]>([]);
  const [pendingItems, setPendingItems] = useState<outbox.OutboxItem[]>([]);
  // The gate's roster and the guard who has signed in on this phone. A device
  // serves whoever is on shift, so this is per-session rather than per-device.
  const [roster, setRoster] = useState<GuardOption[]>([]);
  const [me, setMe] = useState<GuardOption | null>(null);
  // The live face signature and what it scored against this guard's stored one.
  const selfieRef = useRef<HTMLVideoElement>(null);
  const selfieStream = useRef<MediaStream | null>(null);
  const [selfieCam, setSelfieCam] = useState<"starting" | "live" | "blocked" | "frozen">("starting");
  const [shotUrl, setShotUrl] = useState<string | null>(null);
  // The ITEM photo's preview, kept apart from the selfie's above. They live on
  // different screens today; one refactor away from not doing, and an evidence
  // photo showing the wrong picture is not a bug anybody would catch by eye.
  const [itemUrl, setItemUrl] = useState<string | null>(null);
  // Bumped to restart the selfie camera after a retake.
  const [selfieNonce, setSelfieNonce] = useState(0);
  const [faceScore, setFaceScore] = useState<number | null>(null);
  const [faceVerdict, setFaceVerdict] = useState<"pass" | "review" | "fail" | "no_face" | null>(null);
  const [matching, setMatching] = useState(false);

  // Remembered across a reload. A guard who drops the phone mid-trip should
  // come back to the trip, not to the sign-in list.
  useEffect(() => {
    if (["loading", "unpaired", "who", "pin"].includes(screen)) return;
    try { localStorage.setItem("gate.screen", screen); } catch { /* storage blocked */ }
  }, [screen]);

  // The day's totals, kept against the date so they reset themselves at
  // midnight rather than carrying yesterday's numbers into this morning.
  const saveDay = (t: number, i: number) => {
    try {
      localStorage.setItem("gate.day", JSON.stringify({
        d: new Date().toISOString().slice(0, 10), trips: t, items: i,
      }));
    } catch { /* storage blocked */ }
  };

  const refreshQueue = useCallback(async () => {
    const c = await outbox.counts();
    setQueue({ waiting: c.waiting, rejected: c.rejected });
    const all = await outbox.all();
    setRejected(all.filter((i) => i.rejected));
    setPendingItems(all.filter((i) => !i.rejected));
  }, []);

  /* ── boot ──────────────────────────────────────────────────────────
     WRAPPED, because it was not. Any throw in here -- IndexedDB unavailable in
     a private window, a storage quota refusal, a malformed cached value -- left
     the screen on "loading" forever with nothing on it. A blank white page is
     the worst possible failure: it says neither what went wrong nor what to do,
     and it is indistinguishable from a dead phone. */
  useEffect(() => {
    (async () => {
      try {
        const saved = localStorage.getItem("gate.lang") as LangId | null;
        if (saved) setLang(saved);
        setNight(localStorage.getItem("gate.night") === "1");
      } catch { /* storage blocked — defaults are fine */ }

      // Restore the day's totals and the open trip's clock.
      try {
        const raw = localStorage.getItem("gate.day");
        if (raw) {
          const d = JSON.parse(raw) as { d: string; trips: number; items: number };
          if (d.d === new Date().toISOString().slice(0, 10)) {
            setTrips(d.trips); setItemsToday(d.items);
          }
        }
        const t = localStorage.getItem("gate.t0");
        if (t) setT0(Number(t));
      } catch { /* storage blocked — totals restart, nothing is lost */ }

      let token: string | null = null;
      try { token = getToken(); } catch { /* storage blocked */ }
      if (!token) { setScreen("unpaired"); return; }

      // The queue lives in IndexedDB, which a locked-down browser can refuse
      // outright. That must not stop the app opening.
      try { await refreshQueue(); } catch { /* shown as zero until it recovers */ }

      // Fleet in the background, deliberately NOT awaited. It is a
      // convenience on a screen the guard has not reached yet; making the
      // splash wait on a Mongo round trip to get there would be the wrong
      // trade in every direction.
      void loadFleet();

      let sawRoster = false;
      try {
        const r = await rosterFor();
        setRoster(r.guards);
        sawRoster = true;
        const saved = getGuardId();
        setMe(saved ? r.guards.find((g) => g.guardId === saved) ?? null : null);
      } catch { /* offline, or the device was revoked — handled below */ }

      try {
        const b = await bootstrap();
        setBoot(b);
        if (b.openShift) { setShiftId(b.openShift.client_shift_id); setShiftAt(b.openShift.checked_in_at); }
        // A phone that died mid-trip returns to the SAME truck rather than
        // quietly opening a second one against the same load.
        if (b.openTrip) {
          setTripId(b.openTrip.client_trip_id);
          setDir(b.openTrip.direction);
          setVeh(b.openTrip.vehicle_no);
        }
        // Rebuild the open trip's item list from the outbox, so a reload shows
        // the scans already made rather than an empty trip that looks lost.
        if (b.openTrip) {
          const queued = (await outbox.all()).filter(
            (i) => i.kind === "scan" && i.payload.clientTripId === b.openTrip!.client_trip_id
          );
          setLines(queued.reverse().map((i) => ({
            clientId: i.clientId,
            barcode: String(i.payload.barcode ?? i.payload.serialNo ?? ""),
            label: String(i.payload.product ?? ""),
            flagged: !!i.payload.overrideReason || i.payload.entryMethod === "manual",
            rawBarcode: (i.payload.barcode as string | null) ?? null,
          })));
          for (const i of queued) {
            if (i.payload.barcode) seenRef.current.add(String(i.payload.barcode));
          }
        }
        setScreen(getGuardId() ? "pin" : "who");
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // A REVOKED device is not an outage and must not look like one -- the
        // guard would stand there retrying a phone that will never work again.
        if (/revoked|unknown device|401|403/i.test(msg)) {
          setProblem({ titleKey: "deviceRevoked", bodyKey: "deviceRevokedWhy" });
          setScreen("problem");
          return;
        }
        setOnline(false);
        setErr(msg);
      }

      // Offline at shift start is ordinary: the app runs from the outbox and
      // whatever the last successful start-up gave it. Land on a real screen.
      setScreen(getGuardId() ? "pin" : sawRoster ? "who" : "problem");
      if (!sawRoster && !getGuardId()) {
        setProblem({ titleKey: "somethingWrong", bodyKey: "offline" });
      }
    })().catch(() => {
      // Nothing above should throw now, but a start-up that CAN hang must not.
      setProblem({ titleKey: "somethingWrong", bodyKey: "offline" });
      setScreen("problem");
    });
  }, [refreshQueue, loadFleet]);

  // One listener rather than sixty handlers. Capture phase, so it fires even
  // when a handler stops propagation, and it deliberately skips the scanner
  // viewport — that already has its own distinct tone and buzz, and two sounds
  // for one scan is worse than none.
  useEffect(() => {
    const onTap = (e: Event) => {
      const el = (e.target as HTMLElement)?.closest?.("button, .gkey, label.gbtn");
      if (!el || el.closest(".gview")) return;
      if ((el as HTMLButtonElement).disabled) return;
      click();
    };
    document.addEventListener("click", onTap, true);
    return () => document.removeEventListener("click", onTap, true);
  }, []);

  /* ── background sync ───────────────────────────────────────────────── */
  const sync = useCallback(async () => {
    const r = await drain();
    setOnline(!r.offline);
    await refreshQueue();
    return r;
  }, [refreshQueue]);

  // NOT PRELOADED ANY MORE, and the reason matters.
  //
  // This used to warm the face model on the PIN screen so the pause landed
  // while the guard was typing. On a desktop that is a kindness; on an iPhone
  // it is a hazard. iOS Safari enforces a per-tab memory ceiling and kills the
  // page outright when it is crossed -- no error, no message, just a blank
  // screen. TensorFlow plus 6.7MB of weights is squarely in that territory, and
  // every engine available here (Chromium, desktop WebKit) has no such ceiling,
  // so nothing local reproduces it.
  //
  // The model now loads only when the guard actually taps to take the selfie,
  // and only on that screen. A guard who never checks in never pays for it, and
  // the scanning path -- the part that must not fail -- never touches it at all.

  useEffect(() => {
    const id = setInterval(() => { void sync(); }, 20_000);
    const on = () => { setOnline(true); void sync(); };
    window.addEventListener("online", on);
    window.addEventListener("offline", () => setOnline(false));
    return () => { clearInterval(id); window.removeEventListener("online", on); };
  }, [sync]);

  /* ── selfie camera ─────────────────────────────────────────────────────
     A VISIBLE, PLAYING video element, not an off-DOM one grabbed after a fixed
     delay. The old version created a detached <video>, waited half a second and
     read a frame — which on a real phone returns black: an element that is not
     in the document is not guaranteed to render, and half a second is a guess
     at how long a front camera takes to produce its first frame, not a fact.
     Here the guard can SEE themselves before they tap, which also means they
     can tell the difference between a bad photo and a broken camera. */
  useEffect(() => {
    if (screen !== "checkin" && screen !== "randomcheck") {
      selfieStream.current?.getTracks().forEach((t) => t.stop());
      selfieStream.current = null;
      return;
    }
    let live = true;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) { setSelfieCam("blocked"); return; }
        const st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
        if (!live) { st.getTracks().forEach((t) => t.stop()); return; }
        selfieStream.current = st;
        if (selfieRef.current) {
          selfieRef.current.srcObject = st;
          await selfieRef.current.play().catch(() => {});
        }
        setSelfieCam("live");
      } catch { setSelfieCam("blocked"); }
    })();
    return () => {
      live = false;
      selfieStream.current?.getTracks().forEach((t) => t.stop());
      selfieStream.current = null;
    };
  }, [screen, selfieNonce]);

  /* ── scanner camera ────────────────────────────────────────────────────── */
  useEffect(() => {
    if (screen !== "scan") {
      if (loopRef.current) cancelAnimationFrame(loopRef.current);
      stopCamera(streamRef.current); streamRef.current = null;
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        await initScanner();
        if (!videoRef.current || cancelled) return;
        streamRef.current = await openCamera(videoRef.current);
        const tick = async () => {
          if (cancelled) return;
          if (!busyRef.current && videoRef.current && workRef.current) {
            const hit = await decodeFrame(videoRef.current, workRef.current);
            if (hit) await onDecodedRef.current(hit.value);
          }
          loopRef.current = requestAnimationFrame(() => void tick());
        };
        void tick();
      } catch {
        setHint(t("cameraBlocked"));
      }
    })();
    return () => {
      cancelled = true;
      if (loopRef.current) cancelAnimationFrame(loopRef.current);
      stopCamera(streamRef.current); streamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  /* ── scanning ──────────────────────────────────────────────────────── */
  async function onDecoded(raw: string) {
    const barcode = raw.trim();
    if (!barcode) return;
    busyRef.current = true;
    try {
      // Already on this truck. Warned in the moment, where the mistake is cheap
      // — not found tonight by reconciliation, after the truck has gone.
      if (seenRef.current.has(barcode)) {
        feedback(false); setFlash("warn"); setHint(`${t("alreadyScanned")} · ${barcode}`);
        await pause(900); return;
      }
      // The freshly-read list when there is one, the copy bootstrap brought
      // otherwise. Never nothing: an item is only "not on the list" if there
      // is a list, and treating an absent one as an empty one would make every
      // scan an exception.
      const match = (expected ?? boot?.expected ?? []).find(
        (e) => e.barcode === barcode || e.barcode_canon === canonicalize(barcode)
      );
      // The check runs even when it is not shown. Recording what it WOULD have
      // said is how the false-alarm rate gets measured before any guard is
      // taught to dismiss a warning.
      const listed = !!match;
      if (!listed && boot?.config.expectedCheckLive) {
        feedback(false); setFlash("warn");
        setPendingScan({ barcode, label: barcode });
        setReason(null); setPhoto(null);
        await pause(220); setScreen("resolve"); return;
      }
      feedback(true); setFlash("ok");
      await addScan({
        barcode,
        entryMethod: "scan",
        itemKind: "unit",
        product: match?.product ?? null,
        soNumber: match?.so_number ?? null,
        ticketId: match?.ticket_id ?? null,
        customer: match?.customer ?? null,
      }, match?.product ?? barcode, false);
      setHint("");
    } finally {
      // A short cooldown so one sticker held in view is not decoded thirty
      // times a second.
      setTimeout(() => { busyRef.current = false; setFlash(""); }, 650);
    }
  }

  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const stampElapsed = () => {
    if (!t0) { setElapsed("—"); return; }
    const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
    setElapsed(secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`);
  };

  async function addScan(
    payload: Record<string, unknown>,
    label: string,
    flagged: boolean,
    blob?: Blob | null
  ) {
    const clientId = uid();
    const pos = await position();
    await outbox.enqueue({
      clientId, kind: "scan",
      payload: {
        clientScanId: clientId,
        clientTripId: tripId,
        scannedAt: new Date().toISOString(),
        quantity: 1,
        hasPhoto: !!blob,
        lat: pos?.coords.latitude ?? null,
        lng: pos?.coords.longitude ?? null,
        accuracyM: pos?.coords.accuracy ?? null,
        ...payload,
      },
    });
    if (blob) await outbox.putBlob(clientId, blob);
    const bc = String(payload.barcode ?? payload.serialNo ?? label);
    if (payload.barcode) seenRef.current.add(String(payload.barcode));
    setLines((l) => {
      const next = [{ clientId, barcode: bc, label, flagged,
                      rawBarcode: (payload.barcode as string | null) ?? null }, ...l];
      if (t0) setRate(`${((Date.now() - t0) / 1000 / next.length).toFixed(1)}s`);
      return next;
    });
    await refreshQueue();
    void sync();
  }

  /* ── taking a scan back ────────────────────────────────────────────────
     A guard scans the box on the wrong pallet, or the driver refuses one at
     the door. Without this the only options were leaving a wrong row in the
     record or closing the trip and starting again, and the first is what
     actually happened -- which is how a digital register starts lying in
     exactly the way the paper one did.

     Two paths, and which one applies is invisible to the guard:
       still queued   delete it, nothing was ever claimed
       already sent   queue a VOID, because the server is counting it
     Either way the barcode is released so the item can be scanned again. */
  async function removeLine(line: ScanLine) {
    const wasQueued = await outbox.removeIfQueued(line.clientId);
    if (!wasQueued) {
      const voidId = uid();
      await outbox.enqueue({
        clientId: voidId, kind: "void",
        payload: {
          clientScanId: line.clientId,
          reason: "removed by the guard during the trip",
          voidedAt: new Date().toISOString(),
        },
      });
    }
    if (line.rawBarcode) seenRef.current.delete(line.rawBarcode);
    setLines((l) => l.filter((x) => x.clientId !== line.clientId));
    setConfirmRemove(null);
    await refreshQueue();
    void sync();
  }

  // Point the loop at the latest closure AFTER each render, not during one —
  // a ref written while rendering is a side effect in the render path.
  useEffect(() => { onDecodedRef.current = onDecoded; });

  /* ── the check-in selfie ───────────────────────────────────────────────── */
  const [faceReady, setFaceReady] = useState(false);

  async function takeSelfie() {
    const v = selfieRef.current;
    // videoWidth is 0 until the first frame has actually arrived. Checking it
    // is what makes this reliable where a timer was not.
    if (!v?.videoWidth) return;
    setMatching(true);
    try {
      // FREEZE FIRST. The frame is grabbed and the camera stopped before any
      // matching begins — leaving a live face moving under the still it is
      // being compared against reads as "still working" and invites a retap.
      const blob = await compress(v, 640, 0.75);
      setPhoto(blob);
      setShotUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(blob); });
      selfieStream.current?.getTracks().forEach((t) => t.stop());
      selfieStream.current = null;
      setSelfieCam("frozen");
      // Only now the comparison, which may have to fetch the model first.
      if (!faceReady) { await initFace(); setFaceReady(true); }
      // Runs on the phone. Nothing is uploaded to decide it.
      const live = await describeFace(v);
      const r = compare(live, fromArray(me?.descriptor));
      setFaceScore(r.score); setFaceVerdict(r.verdict);
    } catch {
      // The model failed to load, or the frame was unreadable. Recorded as
      // needing a look rather than blocking the shift — a guard who cannot
      // check in leaves no attendance record at all.
      setFaceVerdict("no_face");
    } finally { setMatching(false); }
  }

  function retakeSelfie() {
    setPhoto(null); setFaceScore(null); setFaceVerdict(null);
    setShotUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    // The stream was stopped at capture, so retaking has to start a new one.
    setSelfieCam("starting");
    setSelfieNonce((n) => n + 1);
  }

  /* ── photographing an ITEM (manual entry, overrides) ───────────────────
     Its own rear camera, opened only while the sheet is up. This used to read
     the scanner's video element, which is unmounted on these screens, so the
     button did nothing at all — and since both screens require a photo before
     they can be saved, neither could be completed. */
  const itemVidRef = useRef<HTMLVideoElement>(null);
  const itemStream = useRef<MediaStream | null>(null);
  const [itemCam, setItemCam] = useState<"off" | "starting" | "live" | "blocked">("off");

  const openItemCamera = useCallback(async () => {
    setItemCam("starting");
    try {
      const st = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
      });
      itemStream.current = st;
      if (itemVidRef.current) {
        itemVidRef.current.srcObject = st;
        await itemVidRef.current.play().catch(() => {});
      }
      setItemCam("live");
    } catch { setItemCam("blocked"); }
  }, []);

  const closeItemCamera = useCallback(() => {
    itemStream.current?.getTracks().forEach((t) => t.stop());
    itemStream.current = null;
    setItemCam("off");
  }, []);

  /**
   * Take the shot.
   *
   * Split out from opening the camera on purpose. One control that meant
   * "open", then "capture", then nothing was impossible to label honestly --
   * the box said "Take photo" while already showing a live picture, and a
   * guard who wanted a second try had to cancel the whole entry. Now the
   * viewfinder is a viewfinder and the button underneath is a shutter.
   */
  async function shootPhoto() {
    const v = itemVidRef.current;
    if (!v?.videoWidth) return;          // no frame has arrived yet
    const blob = await compress(v, 900, 0.7);
    setPhoto(blob);
    setItemUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(blob); });
    closeItemCamera();
  }

  /** Throw the shot away and reopen the viewfinder. */
  async function retakePhoto() {
    setPhoto(null);
    setItemUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    await openItemCamera();
  }

  /** Forget the item shot entirely — on leaving or completing an entry. */
  const clearItemPhoto = useCallback(() => {
    setPhoto(null);
    setItemUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
  }, []);

  // Never leave a camera running behind a screen the guard has left. The
  // cleanup runs on the way OUT rather than synchronously on the way in, which
  // is both correct and avoids a cascading render.
  useEffect(() => {
    if (screen === "manual" || screen === "resolve") return;
    return () => closeItemCamera();
  }, [screen, closeItemCamera]);

  /* ── trip ──────────────────────────────────────────────────────────── */
  // Direction, vehicle and delivery agent are all required. A trip without an
  // agent named cannot be traced back to a person once the truck has gone,
  // which is most of the point of recording it.
  const tripMissing = [
    !dir && "inOrOut",
    veh.trim().length < 4 && "vehicleNo",
    drv.trim().length < 2 && "deliveryAgent",
  ].filter(Boolean) as string[];

  /** The face the phone compared is confidently not this guard's. */
  const faceBlocked = blocksEntry(faceVerdict);

  /**
   * Is anything planned for this trip still unscanned?
   *
   * Derived rather than stored: it is a pure function of the scans and the
   * list, both already in state, and a copy kept in a third place is a copy
   * that eventually disagrees with them.
   *
   * The guard never chose a job. The jobs in scope were worked out from what
   * they scanned — see lib/gate/completeness.ts for why that distinction is
   * the difference between an independent record and an echo of Odoo.
   */
  const completeness: Completeness | null = useMemo(() => {
    if (!dir) return null;
    const list = expected ?? boot?.expected ?? null;
    if (!list) return null;
    return assessTrip(
      lines.map((l) => ({ barcode: l.rawBarcode ?? null, serialNo: l.rawBarcode ? null : l.barcode })),
      list.map((e) => ({
        barcode: e.barcode, barcodeCanon: e.barcode_canon, direction: e.direction,
        pickingRef: e.picking_ref, product: e.product, soNumber: e.so_number,
        customer: e.customer, deliveryAddress: e.delivery_address,
      })),
      dir
    );
  }, [lines, expected, boot, dir]);

  async function startTrip() {
    if (tripMissing.length > 0) return;
    const clientId = uid();
    await outbox.enqueue({
      clientId, kind: "trip",
      payload: {
        clientTripId: clientId, direction: dir,
        vehicleNo: veh.trim().toUpperCase(),
        driverName: drv.trim() || null,
        openedAt: new Date().toISOString(), status: "open",
      },
    });
    setTripId(clientId); setLines([]); seenRef.current = new Set();
    // Not awaited: the scanner opens now. The first scan of a trip is seconds
    // away and the list will be there for it; blocking the camera on Metabase
    // would be the wrong trade every time.
    void loadExpected();
    const started = Date.now();
    setT0(started);
    try { localStorage.setItem("gate.t0", String(started)); } catch { /* storage blocked */ }
    await refreshQueue(); void sync();
    setScreen("scan");
  }

  async function closeTrip() {
    if (!tripId) return;
    await outbox.enqueue({
      clientId: `${tripId}-close`, kind: "trip",
      payload: {
        clientTripId: tripId, direction: dir, vehicleNo: veh.trim().toUpperCase(),
        openedAt: new Date(t0 || Date.now()).toISOString(),
        closedAt: new Date().toISOString(), status: "closed",
        // THE GAP TRAVELS WITH THE CLOSE, whether or not the guard was shown
        // it. Recording only the warnings a guard saw would measure the
        // false-alarm rate against people who were never warned — which is the
        // one number the silent week exists to produce.
        ...(completeness ? {
          completeness: {
            expectedTotal: completeness.expectedTotal,
            expectedScanned: completeness.expectedScanned,
            missing: completeness.missing.map((m) => m.barcode),
            unplannedCount: completeness.unplannedCount,
            // Whether the panel above was actually on screen. False for the
            // whole pilot, and it must stay distinguishable from true.
            // Whether the panel was actually ON SCREEN — not whether the
            // per-scan interruption is live, which is a different switch. Get
            // this wrong and the false-alarm rate is measured against guards
            // who were shown nothing, which is the one number the silent
            // period exists to produce.
            warned: boot?.config.completenessShown !== false
                    && completeness.missing.length > 0,
            listAgeS: expectedStale ? null : 0,
          },
        } : {}),
      },
    });
    setTrips((n) => { const v = n + 1; saveDay(v, itemsToday + lines.length); return v; });
    setItemsToday((n) => n + lines.length);
    try { localStorage.removeItem("gate.t0"); } catch { /* storage blocked */ }
    setTripId(null); setDir(null); setVeh(""); setDrv("");
    setLines([]); seenRef.current = new Set();
    await refreshQueue(); void sync(); setScreen("today");
  }

  const loadHistory = useCallback(async (d: string) => {
    setHist(null); setHistErr(null);
    try { setHist(await history(d)); }
    catch (e) { setHistErr(e instanceof Error ? e.message : String(e)); }
  }, []);

  /* ── random in-shift photo checks ──────────────────────────────────────
     Two or three per shift at unannounced moments, confirming the same person
     is still on duty. Start and end of shift prove who arrived and who left;
     these are what make substitution in between visible.

     Scheduled once and persisted. Drawing new times on each app start would
     let a guard avoid every prompt by reopening the app, and a check you can
     dodge is not a check. */
  const scheduleChecks = useCallback((startedAt: number) => {
    const SHIFT_H = 9;
    const n = 2 + Math.floor(Math.random() * 2);          // two or three
    const times: number[] = [];
    for (let i = 0; i < n; i++) {
      // One per slice of the shift, at a random point inside it, so they are
      // spread out rather than arriving together.
      const lo = ((i + 0.5) / (n + 1)) * SHIFT_H * 3600_000;
      const hi = ((i + 1.5) / (n + 1)) * SHIFT_H * 3600_000;
      times.push(Math.round(startedAt + lo + Math.random() * (hi - lo)));
    }
    setCheckTimes(times);
    try { localStorage.setItem("gate.checks", JSON.stringify(times)); } catch { /* storage blocked */ }
  }, []);

  useEffect(() => {
    if (!shiftId) return;
    // Deferred by a tick so the read-or-schedule is not a synchronous setState
    // in an effect body, which cascades renders.
    const id = setTimeout(() => {
      let saved: string | null = null;
      try { saved = localStorage.getItem("gate.checks"); } catch { /* storage blocked */ }
      if (saved) {
        try { setCheckTimes(JSON.parse(saved) as number[]); return; } catch { /* corrupt */ }
      }
      scheduleChecks(shiftAt ? Date.parse(shiftAt) : Date.now());
    }, 0);
    return () => clearTimeout(id);
  }, [shiftId, shiftAt, scheduleChecks]);

  useEffect(() => {
    if (!shiftId || checkTimes.length === 0) return;
    const id = setInterval(() => {
      // Never interrupt a scan in progress. A prompt over a live scanner mid-
      // load is exactly how a guard learns to resent the app; it waits for a
      // quiet screen instead, which arrives within minutes.
      if (screen === "scan" || screen === "resolve" || screen === "manual"
          || screen === "randomcheck" || screen === "checkin") return;
      const due = checkTimes.find((t) => Date.now() >= t);
      if (!due) return;
      setCheckTimes((ts) => {
        const left = ts.filter((t) => t !== due);
        try { localStorage.setItem("gate.checks", JSON.stringify(left)); } catch {}
        return left;
      });
      setScreenBefore(screen);
      setPhoto(null); setFaceScore(null); setFaceVerdict(null);
      setShotUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
      setSelfieCam("starting"); setSelfieNonce((n) => n + 1);
      setScreen("randomcheck");
    }, 30_000);
    return () => clearInterval(id);
  }, [shiftId, checkTimes, screen]);

  async function submitRandomCheck() {
    const id = uid();
    const pos = await position();
    await outbox.enqueue({
      clientId: id, kind: "face",
      payload: {
        clientCheckId: id, clientShiftId: shiftId, trigger: "random",
        capturedAt: new Date().toISOString(),
        // 'skipped' is deliberate and not a failure: a prompt the guard could
        // not answer must read as unanswered, never as a mismatch.
        verdict: photo ? (faceVerdict ?? "review") : "skipped",
        matchScore: faceScore, hasSelfie: !!photo,
        lat: pos?.coords.latitude ?? null, lng: pos?.coords.longitude ?? null,
      },
    });
    if (photo) await outbox.putBlob(id, photo);
    setPhoto(null); setFaceScore(null); setFaceVerdict(null);
    setShotUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    await refreshQueue(); void sync();
    setScreen(screenBefore);
  }

  /* ── attendance ────────────────────────────────────────────────────── */
  async function checkOut() {
    if (!shiftId) return;
    const pos = await position();
    // Same client id as the check-in, so the server updates that shift rather
    // than creating a second one — the sync layer treats a repeat id as an
    // update when a checkedOutAt arrives.
    await outbox.enqueue({
      clientId: `${shiftId}-out`, kind: "shift",
      payload: {
        clientShiftId: shiftId,
        checkedInAt: shiftAt ?? new Date().toISOString(),
        checkedOutAt: new Date().toISOString(),
        status: "closed",
        outLat: pos?.coords.latitude ?? null,
        outLng: pos?.coords.longitude ?? null,
      },
    });
    await refreshQueue(); void sync();
  }

  async function handOver() {
    // End the shift properly before the next guard signs in. Without this the
    // attendance record never closes and the previous guard shows as on duty.
    await checkOut();
    clearGuardId(); setMe(null); setShiftId(null); setShiftAt(null);
    setTrips(0); setItemsToday(0);
    setScreen("who");
  }

  async function doCheckIn() {
    // Belt and braces. The button is disabled in both these cases, but a
    // check-in is the one moment identity is established for everything that
    // follows, so it does not rely on a disabled attribute to hold the line.
    if (!photo || blocksEntry(faceVerdict)) return;
    const clientId = uid();
    const pos = await position();
    await outbox.enqueue({
      clientId, kind: "shift",
      payload: {
        clientShiftId: clientId, checkedInAt: new Date().toISOString(), status: "open",
        inLat: pos?.coords.latitude ?? null, inLng: pos?.coords.longitude ?? null,
      },
    });
    // The selfie is captured and queued with the verdict the phone reached.
    // A 'fail' never gets this far -- it was refused above -- so what lands
    // here is a pass, or something a manager should glance at.
    const faceId = uid();
    await outbox.enqueue({
      clientId: faceId, kind: "face",
      payload: {
        clientCheckId: faceId, clientShiftId: clientId, trigger: "check_in",
        capturedAt: new Date().toISOString(),
        // The on-device verdict. A clean pass is filed and forgotten; a
        // borderline one goes to a manager to glance at. A confident mismatch
        // cannot appear here because it never got past the button.
        verdict: faceVerdict ?? "review",
        matchScore: faceScore,
        hasSelfie: !!photo, lat: pos?.coords.latitude ?? null, lng: pos?.coords.longitude ?? null,
      },
    });
    if (photo) await outbox.putBlob(faceId, photo);
    setShiftId(clientId); setShiftAt(new Date().toISOString());
    setPhoto(null); setFaceScore(null); setFaceVerdict(null);
    await refreshQueue(); void sync(); setScreen("today");
  }

  /* ── render ────────────────────────────────────────────────────────── */
  return (
    <div className={`gate${night ? " night" : ""}`}>
      <canvas ref={workRef} style={{ display: "none" }} />

      {/* Permanent. Outside the screen switch on purpose — rendered per screen
          it would eventually drift, and a brand mark that moves is worse than
          none. */}
      <div className="gbrand">
        {/* eslint-disable-next-line @next/next/no-img-element -- a 26px mark;
            next/image would add a loader and a layout pass for no benefit. */}
        <img src="/apple-icon.png" alt="Cityfurnish" width={26} height={26} className="mark" />
        <span className="name">Gate Check</span>
        <span className="spacer" />
        {/* Who is signed in, always visible. On a shared phone the single most
            useful thing to be able to glance at. */}
        {me && (
          <button className="who" onClick={() => setScreen("profile")}>{me.name}</button>
        )}
      </div>

      {screen === "loading" && (
        <Center>
          <div className="ghero">
            <div className="gspin" style={{ margin: "0 auto 14px" }} />
            <p>{t("starting")}</p>
          </div>
        </Center>
      )}

      {screen === "unpaired" && (
        <Center>
          <div className="ghero">
            <div className="gglyph"><Icon name="lock" size={46} /></div>
            <h1>{t("notPaired")}</h1>
            <p>{t("askManager")}</p>
          </div>
        </Center>
      )}

      {/* ── The states that decide whether a guard trusts this thing ──────
          A guard who cannot tell whether their work is safe will start
          keeping a paper copy, and then there are two registers again. So
          each of these says plainly what happened, whether the work is
          safe, and what to do — never a bare error string. */}
      {screen === "problem" && (
        <>
          <Bar t={t} title={t("appName")}
               left={<BackBtn onClick={() => setScreen(shiftId ? "today" : "who")} />} />
          <div className="gbody">
            <div className="ghero">
              <div className="gglyph"><Icon name="warning" size={46} /></div>
              <h1>{problem ? t(problem.titleKey) : t("somethingWrong")}</h1>
              <p>{problem ? t(problem.bodyKey) : ""}</p>
            </div>
            {/* Reassurance first: the queue survives everything on this screen. */}
            <div className="gcard ok">
              <Icon name="check_circle" size={22} className="gbig" />
              <div>
                <b>{t("workIsSafe")}</b>
                <span>{queue.waiting} {t("waiting")}</span>
              </div>
            </div>
          </div>
          <div className="gfoot">
            <button className="gbtn primary" onClick={() => { setProblem(null); void sync();
              setScreen(shiftId ? "today" : "who"); }}>{t("retry")}</button>
          </div>
        </>
      )}

      {screen === "queue" && (
        <>
          <Bar t={t} title={t("queueTitle")}
               left={<BackBtn onClick={() => setScreen("today")} />} />
          <div className="gbody">
            <SyncCard t={t} online={online} queue={queue} />

            {/* What is actually waiting. The screen used to list only refused
                rows, so "2 waiting to send" opened onto nothing at all -- which
                reads as the app having lost them. */}
            {pendingItems.length > 0 && (
              <>
                <h3 className="ghead">{t("stillToSend")}</h3>
                {pendingItems.map((i) => (
                  <div key={i.clientId} className="gkv">
                    <span>{t(KIND_LABEL[i.kind])}
                      {i.payload.barcode ? <span className="mono"> · {String(i.payload.barcode)}</span> : null}
                    </span>
                    <span className="gsub">{when(i.createdAt)}</span>
                  </div>
                ))}
              </>
            )}

            {queue.rejected > 0 && (
              <>
                <div className="gcard warn col" style={{ marginTop: 14 }}>
                  <h3><Icon name="warning" size={17} /> {t("someRefused")}</h3>
                  <p>{t("someRefusedWhy")}</p>
                </div>
                {rejected.map((r) => (
                  <div key={r.clientId} className="gkv">
                    <span className="mono">{String((r.payload.barcode ?? r.payload.serialNo ?? r.kind) as string)}</span>
                    <span className="gtag warn">{r.rejected}</span>
                  </div>
                ))}
              </>
            )}

            {queue.waiting === 0 && queue.rejected === 0 && (
              <div className="gcard ok">
                <Icon name="check_circle" size={22} className="gbig" />
                <div><b>{t("allSent")}</b></div>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Profile ─────────────────────────────────────────────────────
          Who is signed in, and the two things a guard needs from it: end
          the shift, or hand the phone over. Both were buried in Settings
          beside the language picker, which is not where anyone looks. */}
      {screen === "profile" && (
        <>
          <Bar t={t} title={t("profile")}
               left={<BackBtn onClick={() => setScreen("today")} />} />
          <div className="gbody">
            <div className="ghero">
              <div className="gglyph"><Icon name="person" size={46} /></div>
              <h1>{me?.name ?? "—"}</h1>
              <p>{me?.employeeCode ? `${t("employeeCode")} ${me.employeeCode}` : ""}</p>
            </div>
            <div className="gcard col">
              <div className="gkv"><span>{t("gate")}</span><b>{boot?.site?.label ?? "—"}</b></div>
              <div className="gkv"><span>{t("onDuty")}</span>
                <b>{shiftAt ? `${t("since")} ${fmt(shiftAt)}` : "—"}</b></div>
              <div className="gkv"><span>{t("tripsToday")}</span><b>{trips}</b></div>
              <div className="gkv"><span>{t("itemsToday")}</span><b>{itemsToday + lines.length}</b></div>
            </div>
          </div>
          <div className="gfoot">
            <button className="gbtn ghost" onClick={handOver}>{t("switchGuard")}</button>
          </div>
        </>
      )}

      {screen === "who" && (
        <>
          <Bar t={t} title={t("whoAreYou")} right={<GearBtn onClick={() => setScreen("settings")} />} />
          <div className="gbody">
            <p className="glead">{t("tapYourName")}</p>
            <div className="gopts">
              {roster.map((g) => (
                <button key={g.guardId} onClick={() => { setMe(g); setPin(""); setPinBad(false); setScreen("pin"); }}>
                  <Icon name="person" size={19} />{g.name}
                  {g.employeeCode && <span className="gsub" style={{ marginLeft: "auto" }}>{g.employeeCode}</span>}
                </button>
              ))}
            </div>
            {roster.length === 0 && <p className="gnote">{t("noGuards")}</p>}
          </div>
        </>
      )}

      {screen === "pin" && (
        <>
          <Bar t={t} title={me?.name ?? t("enterPin")}
               left={<BackBtn onClick={() => { clearGuardId(); setMe(null); setPin(""); setScreen("who"); }} />}
               right={<GearBtn onClick={() => setScreen("settings")} />} />
          <div className="gbody">
            <div className="ghero"><div className="gglyph"><Icon name="lock" size={46} /></div>
              <h1>{pinBad ? t("wrongPin") : t("enterPin")}</h1>
              <p>{t("pinHint")}</p></div>
            <div className="gdots">{[0,1,2,3].map((i) =>
              <i key={i} className={i < pin.length ? "on" : ""} />)}</div>
            <div className="gpad">
              {[1,2,3,4,5,6,7,8,9,"",0,"⌫"].map((k, i) => (
                <button key={i} className={`gkey${k === "" ? " blank" : ""}`} disabled={k === ""}
                  onClick={async () => {
                    setPinBad(false);
                    if (k === "⌫") return setPin((p) => p.slice(0, -1));
                    const next = pin.length < 4 ? pin + k : pin;
                    setPin(next);
                    if (next.length === 4 && me) {
                      const ok = await signIn(me.guardId, next);
                      setPin("");
                      if (ok) {
                        // Their own state, not the phone's previous user's.
                        // `onShift` is read from the RESPONSE rather than from
                        // shiftId, which setShiftId has not written yet at this
                        // point in the closure: a guard who reloaded mid-shift
                        // was sent back to check-in as though they had just
                        // arrived. Harmless while check-in was skippable; now
                        // that it demands a matching photo it would strand
                        // them, so it is read from the value we just fetched.
                        let onShift = !!shiftId;
                        try { const b = await bootstrap(); setBoot(b);
                          if (b.openShift) { setShiftId(b.openShift.client_shift_id);
                                             setShiftAt(b.openShift.checked_in_at);
                                             onShift = true; } } catch { /* offline */ }
                        // Back to whatever they were doing, if it still makes
                        // sense; otherwise the normal start of a shift.
                        let resume: Screen | null = null;
                        try { resume = localStorage.getItem("gate.screen") as Screen | null; } catch {}
                        setScreen(
                          !onShift ? "checkin"
                          : resume && ["today","scan","newtrip","closetrip","queue","profile"].includes(resume)
                            ? resume : "today"
                        );
                      } else setPinBad(true);
                    }
                  }}>{k}</button>
              ))}
            </div>
          </div>
        </>
      )}

      {screen === "checkin" && (
        <>
          <Bar t={t} title={t("checkIn")} />
          <div className="gbody">
            <div className="gselfiewrap">
              <video ref={selfieRef} playsInline muted autoPlay
                className={selfieCam === "live" && !shotUrl ? "" : "hidden"} />
              {/* eslint-disable-next-line @next/next/no-img-element -- a local
                  blob; next/image cannot take an object URL. */}
              {shotUrl && <img src={shotUrl} alt="" />}
              {!shotUrl && selfieCam !== "live" && (
                <Icon name={selfieCam === "blocked" ? "camera" : "progress_activity"}
                      size={40} className={selfieCam === "starting" ? "gspinicon" : ""} />
              )}
              {matching && <span className="gselfiebusy">
                <Icon name="progress_activity" size={34} className="gspinicon" /></span>}
            </div>

            <div className="gselfiebtns">
              {photo ? (
                <button className="gbtn sm ghost" onClick={retakeSelfie} disabled={matching}>
                  <Icon name="refresh" size={17} />{t("retake")}
                </button>
              ) : (
                <button className="gbtn sm primary" onClick={takeSelfie}
                        disabled={matching || selfieCam !== "live"}>
                  <Icon name="camera" size={17} />{t("takeSelfie")}
                </button>
              )}
            </div>

            <div className={`gcenter-txt${faceBlocked ? " bad" : ""}`}>
              <p>{faceVerdict === "pass" ? t("faceOk")
                 : faceVerdict === "fail" ? t("faceNotYou")
                 : faceVerdict === "no_face" ? t("faceNone")
                 : faceVerdict ? t("faceReview") : t("selfieWhy")}</p>
            </div>
            <GeoCard t={t} boot={boot} />
          </div>
          <div className="gfoot">
            <div style={{ flex: 1 }}>
              {/* Two different refusals, and they must not read the same. No
                  photo is something the guard can fix in three seconds; a face
                  that is not theirs is not, and sending them round the retake
                  loop for it would be a lie. */}
              {!photo && <p className="gmiss">{t("selfieRequired")}</p>}
              {faceBlocked && <p className="gmiss">{t("faceBlockedNote")}</p>}
              <button className="gbtn primary" disabled={!photo || faceBlocked || matching}
                      onClick={doCheckIn}>{t("checkIn")}</button>
            </div>
          </div>
        </>
      )}

      {screen === "today" && (
        <>
          <Bar t={t} title={t("today")} right={<GearBtn onClick={() => setScreen("settings")} />} />
          <div className="gbody">
            <button className="gplain" onClick={() => setScreen("queue")}>
              <SyncCard t={t} online={online} queue={queue} />
            </button>
            {shiftAt && (
              <div className="gcard ok">
                <Icon name="check_circle" size={22} className="gbig" />
                <div><b>{t("onDuty")}</b><span>{t("since")} {fmt(shiftAt)}</span></div>
              </div>
            )}
            <button className="gcard col tap" onClick={() => {
              const d = new Date().toISOString().slice(0, 10);
              setHistDate(d); void loadHistory(d); setScreen("history");
            }}>
              <div className="gkv"><span>{t("tripsToday")}</span><b>{trips}</b></div>
              <div className="gkv"><span>{t("itemsToday")}</span><b>{itemsToday + lines.length}</b></div>
              <div className="gkv" style={{ borderBottom: "none" }}>
                <span className="gsub">{t("viewHistory")}</span>
                <Icon name="chevron_right" size={17} />
              </div>
            </button>
            {err && <p className="gnote">{err}</p>}
          </div>
          <div className="gfoot">
            <button className="gbtn primary" onClick={() => {
              if (tripId) { setScreen("scan"); return; }
              // Re-read the fleet on the way in. The copy fetched when the app
              // opened may be hours old by now, and this is the one screen
              // where being out of date costs the guard a typed truck number.
              setVehTyped(false); setDrvTyped(false);
              void loadFleet();
              setScreen("newtrip");
            }}>
              {tripId ? t("resumeTrip") : `＋ ${t("startTrip")}`}
            </button>
          </div>
        </>
      )}

      {screen === "newtrip" && (
        <>
          <Bar t={t} title={t("startTrip")} left={<BackBtn onClick={() => setScreen("today")} />} />
          <div className="gbody">
            <div className="gbig2">
              <button className="gdir" aria-pressed={dir === "IN"} onClick={() => setDir("IN")}>
                <Icon name="arrow_down" size={30} />{t("inward")}</button>
              <button className="gdir" aria-pressed={dir === "OUT"} onClick={() => setDir("OUT")}>
                <Icon name="arrow_up" size={30} />{t("outward")}</button>
            </div>
            {/* Pick, do not type. Both of these are how a gate row is later
                matched to a planned movement, and both were blank boxes: one
                truck came back as four different strings depending on where
                the guard put the spaces. The list is DT's own spelling. */}
            <Picker t={t} label={t("vehicleNo")} hint={t("pickVehicle")}
                    mono uppercase placeholder="HR26 DK 8337"
                    options={fleet?.vehicles ?? null}
                    unavailable={fleet?.source === "unavailable"}
                    value={veh} onChange={setVeh}
                    typing={vehTyped} onTyping={setVehTyped} />

            <Picker t={t} label={t("deliveryAgent")} hint={t("pickAgent")}
                    options={fleet?.agents ?? null}
                    unavailable={fleet?.source === "unavailable"}
                    value={drv} onChange={setDrv}
                    typing={drvTyped} onTyping={setDrvTyped} />

            <p className="gnote">{t("vehNote")}</p>
          </div>
          <div className="gfoot">
            <div style={{ flex: 1 }}>
              {tripMissing.length > 0 && (
                <p className="gmiss">{t("needs")} {tripMissing.map((k) => t(k)).join(", ")}</p>
              )}
              <button className="gbtn primary" disabled={tripMissing.length > 0}
                      onClick={startTrip}>{t("startScanning")}</button>
            </div>
          </div>
        </>
      )}

      {screen === "scan" && (
        <>
          <Bar t={t} title={dir === "IN" ? t("inward") : t("outward")}
               left={<BackBtn onClick={() => { stampElapsed(); void loadExpected(); setScreen("closetrip"); }} />}
               right={<span className="gsub mono">{veh}</span>} />
          <div className="gscan">
            <div className="gview">
              <video ref={videoRef} playsInline muted />
              <div className="gretic"><i /><i /><i /><i /></div>
              <div className={`gflash ${flash}`} />
              <div className="ghint">{hint || t("pointAtCode")}</div>
            </div>
            <div className="gtally">
              <span className="n">{lines.length}</span>
              <span className="lbl">{t("itemsScanned")}</span>
              <span className="rate mono">{rate}</span>
            </div>
            <div className="gfeed">
              {lines.map((l) => (
                <div key={l.clientId} className={`grow${l.flagged ? " flag" : ""}`}>
                  <span className="tick"><Icon name={l.flagged ? "warning" : "check"} size={15} /></span>
                  <span className="txt"><span className="bc mono">{l.barcode}</span>
                    <span className="nm">{l.label}</span></span>
                  {/* Deliberately small and on the far edge, away from where a
                      thumb rests while scanning. It asks before it acts. */}
                  <button className="gx" aria-label={`${t("remove")} ${l.barcode}`}
                          onClick={() => setConfirmRemove(l)}>
                    <Icon name="close" size={16} />
                  </button>
                </div>
              ))}
            </div>
            <div className="gscanfoot">
              <button className="gbtn sm ghost narrow" onClick={() => {
                setCat(null); setNoSticker(false); setMId(""); setMQty(1);
                setMNote(""); clearItemPhoto(); setManualFrom("scan"); setScreen("manual");
              }}><Icon name="add" size={20} /></button>
              <button className="gbtn sm ok" onClick={() => {
                stampElapsed(); void loadExpected(); setScreen("closetrip");
              }}>{t("doneScanning")}</button>
            </div>
          </div>
        </>
      )}

      {screen === "resolve" && pendingScan && (
        <>
          <Bar t={t} title={t("notOnList")} />
          <div className="gbody">
            <div className="gcard warn col">
              <div className="mono big">{pendingScan.barcode}</div>
            </div>
            <p className="glead">{t("whyLeaving")}</p>
            <div className="gopts">
              {REASONS.map((r) => (
                <button key={r} aria-pressed={reason === r} onClick={() => setReason(r)}>{t(r)}</button>
              ))}
            </div>
            <PhotoBox t={t} photo={photo} url={itemUrl} cam={itemCam} videoRef={itemVidRef}
                      onOpen={openItemCamera} onShoot={shootPhoto} onRetake={retakePhoto} />
          </div>
          <div className="gfoot">
            <button className="gbtn ghost narrow"
                    onClick={() => { setPendingScan(null); clearItemPhoto(); setScreen("scan"); }}>
              {t("cancel")}</button>
            <button className="gbtn warn" disabled={!reason || !photo}
              onClick={async () => {
                await addScan({
                  barcode: pendingScan.barcode, entryMethod: "scan", itemKind: "unit",
                  overrideReason: t(reason!),
                }, t(reason!), true, photo);
                setPendingScan(null); clearItemPhoto(); setReason(null); setScreen("scan");
              }}>{t("allowIt")}</button>
          </div>
        </>
      )}

      {screen === "manual" && (
        <>
          <Bar t={t} title={t("addManually")}
               left={<BackBtn onClick={() => { clearItemPhoto(); setScreen(manualFrom); }} />} />
          <div className="gbody">
            {!cat && (
              <>
                <p className="glead">{t("whatIsIt")}</p>
                <div className="gopts">
                  {(CATS[dir ?? "OUT"]).map(([id, key, icon]) => (
                    <button key={id} onClick={() => { setCat(id); setNoSticker(false); }}>
                      <Icon name={icon} size={19} className="ic" />{t(key)}</button>
                  ))}
                </div>
              </>
            )}
            {cat && (
              <>
                <button className="gcard tap" onClick={() => setCat(null)}>
                  <Icon name={CATS[dir ?? "OUT"].find((c) => c[0] === cat)![2]} size={22} className="gbig" />
                  <div><b>{t(CATS[dir ?? "OUT"].find((c) => c[0] === cat)![1])}</b></div>
                  <span className="gsub">{t("change")}</span>
                </button>

                {cat === "customer_return" && !noSticker ? (
                  <div className="gcard col">
                    <h3>{t("hasSticker")}</h3><p>{t("stickerWhy")}</p>
                    <div className="grow2">
                      <button className="gbtn sm ghost" onClick={() => setScreen("scan")}>{t("yesScanIt")}</button>
                      <button className="gbtn sm warn" onClick={() => setNoSticker(true)}>{t("noSticker")}</button>
                    </div>
                  </div>
                ) : (
                  <>
                    {noSticker && (
                      <div className="gcard warn col">
                        <h3><Icon name="warning" size={17} /> {t("stickerMissing")}</h3><p>{t("stickerMissingWhy")}</p>
                      </div>
                    )}
                    {!COUNTED.includes(cat) && (
                      <Field label={t("serialOrOrder")}>
                        <input className="gf mono" value={mId} onChange={(e) => setMId(e.target.value)} autoComplete="off" />
                      </Field>
                    )}
                    {cat !== "customer_return" && (
                      <Field label={t("quantity")}>
                        <div className="gqty">
                          <button className="gkey" onClick={() => setMQty((q) => Math.max(1, q - 1))}>−</button>
                          <input className="gf mono" inputMode="numeric" value={mQty}
                            onChange={(e) => setMQty(Math.max(1, parseInt(e.target.value, 10) || 1))} />
                          <button className="gkey" onClick={() => setMQty((q) => q + 1)}>＋</button>
                        </div>
                      </Field>
                    )}
                    <PhotoBox t={t} photo={photo} url={itemUrl} cam={itemCam} videoRef={itemVidRef}
                      onOpen={openItemCamera} onShoot={shootPhoto} onRetake={retakePhoto} />
                    <Field label={t("comments")}>
                      <input className="gf" value={mNote} onChange={(e) => setMNote(e.target.value)} autoComplete="off" />
                    </Field>
                  </>
                )}
              </>
            )}
          </div>
          {cat && (cat !== "customer_return" || noSticker) && (
            <div className="gfoot">
              <button className="gbtn ghost narrow"
                      onClick={() => { clearItemPhoto(); setScreen(manualFrom); }}>{t("cancel")}</button>
              <button className="gbtn primary"
                disabled={!photo || (!COUNTED.includes(cat) && mId.trim().length < 4)}
                onClick={async () => {
                  const counted = COUNTED.includes(cat);
                  const label = t(CATS[dir ?? "OUT"].find((c) => c[0] === cat)![1]);
                  await addScan({
                    barcode: null, serialNo: counted ? null : mId.trim().toUpperCase(),
                    entryMethod: "manual", itemKind: cat,
                    quantity: cat === "customer_return" ? 1 : mQty,
                    soNumber: !counted && mId.trim().startsWith("ON-") ? mId.trim() : null,
                    notes: mNote.trim() || null,
                  }, counted ? `${label} × ${mQty}` : label, true, photo);
                  setCat(null); clearItemPhoto(); setMId(""); setMQty(1); setMNote("");
                  setScreen(manualFrom);
                }}>{t("add")}</button>
            </div>
          )}
        </>
      )}

      {screen === "closetrip" && (
        <>
          <Bar t={t} title={t("closeTrip")} left={<BackBtn onClick={() => setScreen("scan")} />} />
          <div className="gbody">
            <div className="gcard col">
              <div className="gkv"><span>{t("direction")}</span><b>{dir === "IN" ? t("inward") : t("outward")}</b></div>
              <div className="gkv"><span>{t("vehicleNo")}</span><b className="mono">{veh}</b></div>
              <div className="gkv"><span>{t("itemsScanned")}</span><b>{lines.length}</b></div>
              <div className="gkv"><span>{t("flagged")}</span><b>{lines.filter((l) => l.flagged).length}</b></div>
              <div className="gkv"><span>{t("timeTaken")}</span><b className="mono">{elapsed}</b></div>
              {completeness && completeness.expectedTotal > 0 && (
                <div className="gkv">
                  <span>{t("againstPlan")}</span>
                  <b className={completeness.missing.length ? "gwarnfg" : "gokfg"}>
                    {completeness.expectedScanned} / {completeness.expectedTotal}
                  </b>
                </div>
              )}
            </div>
            {lines.map((l) => (
              <div key={l.clientId} className="gkv">
                <span className="mono">{l.barcode}</span>
                <span className="growend">
                  <span className={`gtag ${l.flagged ? "warn" : "ok"}`}>
                    <Icon name={l.flagged ? "warning" : "check"} size={12} /></span>
                  <button className="gx" aria-label={`${t("remove")} ${l.barcode}`}
                          onClick={() => setConfirmRemove(l)}>
                    <Icon name="close" size={15} />
                  </button>
                </span>
              </div>
            ))}
          </div>
          {/* ── What is still missing ────────────────────────────────────
              Placed directly above the last-minute add, because the two are
              one thought: here is what the plan says is not on the truck, and
              here is the button to record it if it turns out that it is.

              It NEVER blocks the close. Agreed with operations: a guard who
              cannot close a trip is a guard who stops using the app, and the
              truck leaves either way. What changes is whether anyone can see
              afterwards that it left short. */}
          {completeness && completeness.missing.length > 0
            && boot?.config.completenessShown !== false && (
            <div className="gbody gmissbox">
              <div className="gcard warn col">
                <h3><Icon name="warning" size={18} /> {t("stillMissing")}</h3>
                <p>{t("missingWhy")}</p>
                {completeness.missing.slice(0, 8).map((m) => (
                  <div key={m.barcode} className="gmissrow">
                    <span className="mono">{m.barcode}</span>
                    <span className="gsub">
                      {[m.product, m.customer, m.soNumber].filter(Boolean).join(" · ")}
                    </span>
                    {m.deliveryAddress && <span className="gsub">{m.deliveryAddress}</span>}
                  </div>
                ))}
                {completeness.missing.length > 8 && (
                  <p className="gnote">
                    + {completeness.missing.length - 8} {t("more")}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* ── The last-minute box ──────────────────────────────────────
              Directly above Close trip, because this is where the guard
              already is when the loader shouts that one more went on. The
              alternative -- walk back into the scanner, add it, walk out
              again -- is exactly the friction that produces an unrecorded
              item, and an unrecorded outward item is the failure this whole
              app exists to stop. */}
          <div className="glastmin">
            <p className="gnote">{t("lastMinute")}</p>
            <button className="gbtn sm ghost" onClick={() => {
              setCat(null); setNoSticker(false); setMId(""); setMQty(1);
              setMNote(""); clearItemPhoto(); setManualFrom("closetrip"); setScreen("manual");
            }}><Icon name="add" size={18} />{t("addManually")}</button>
          </div>

          <div className="gfoot">
            <button className="gbtn ghost narrow" onClick={() => setScreen("scan")}>{t("back")}</button>
            <button className="gbtn ok" onClick={closeTrip}>{t("closeTrip")}</button>
          </div>
        </>
      )}

      {/* ── History ────────────────────────────────────────────────────
          This guard's own work, by date. A supervisor's wider view lives in
          the dashboard; here the question is "what did I do?". */}
      {screen === "history" && (
        <>
          <Bar t={t} title={t("history")}
               left={<BackBtn onClick={() => setScreen("today")} />} />
          <div className="gbody">
            <div className="ghistnav">
              <button className="gbtn sm ghost" onClick={() => {
                const d = new Date(histDate); d.setDate(d.getDate() - 1);
                const iso = d.toISOString().slice(0, 10);
                setHistDate(iso); void loadHistory(iso);
              }}><Icon name="chevron_left" size={18} /></button>
              <input type="date" className="gf" value={histDate} max={new Date().toISOString().slice(0,10)}
                onChange={(e) => { setHistDate(e.target.value); void loadHistory(e.target.value); }} />
              <button className="gbtn sm ghost" disabled={histDate >= new Date().toISOString().slice(0,10)}
                onClick={() => {
                  const d = new Date(histDate); d.setDate(d.getDate() + 1);
                  const iso = d.toISOString().slice(0, 10);
                  setHistDate(iso); void loadHistory(iso);
                }}><Icon name="chevron_right" size={18} /></button>
            </div>

            {histErr && <div className="gcard warn col"><p>{histErr}</p></div>}
            {!hist && !histErr && <p className="gnote">{t("starting")}</p>}

            {hist && hist.trips.length === 0 && (
              <div className="gcard"><div><b>{t("nothingThatDay")}</b></div></div>
            )}

            {hist?.trips.map((tr) => (
              <div key={tr.id} className="gcard col">
                <button className="ghistrip" onClick={() => {
                  setOpenTripId(openTripId === tr.id ? null : tr.id);
                }}>
                  <Icon name={tr.direction === "IN" ? "arrow_down" : "arrow_up"} size={18} />
                  <span className="mono">{tr.vehicleNo}</span>
                  <span className="gsub">{tr.itemCount} · {fmt(tr.openedAt)}</span>
                  <Icon name={openTripId === tr.id ? "expand_less" : "expand_more"} size={18} />
                </button>
                {openTripId === tr.id && tr.items.map((it, i) => (
                  <div key={i} className="gkv">
                    <span className="mono">{it.barcode ?? t("kindScan")}</span>
                    <span className="gsub">
                      {it.quantity > 1 ? `× ${it.quantity} · ` : ""}
                      {it.override ? t("rsnOther") : it.entryMethod === "manual" ? t("addManually") : ""}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── Random photo check ──────────────────────────────────────────
          Unannounced, and deliberately not dismissible without answering one
          way or the other — but "not now" IS an answer, recorded as skipped
          rather than as a failure. A guard with their hands full is not a
          guard committing fraud. */}
      {screen === "randomcheck" && (
        <>
          <Bar t={t} title={t("photoCheck")} />
          <div className="gbody">
            <div className="gselfiewrap">
              <video ref={selfieRef} playsInline muted autoPlay
                className={selfieCam === "live" && !shotUrl ? "" : "hidden"} />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {shotUrl && <img src={shotUrl} alt="" />}
              {!shotUrl && selfieCam !== "live" && (
                <Icon name={selfieCam === "blocked" ? "camera" : "progress_activity"}
                      size={40} className={selfieCam === "starting" ? "gspinicon" : ""} />
              )}
              {matching && <span className="gselfiebusy">
                <Icon name="progress_activity" size={34} className="gspinicon" /></span>}
            </div>
            <div className="gselfiebtns">
              {photo ? (
                <button className="gbtn sm ghost" onClick={retakeSelfie} disabled={matching}>
                  <Icon name="refresh" size={17} />{t("retake")}
                </button>
              ) : (
                <button className="gbtn sm primary" onClick={takeSelfie}
                        disabled={matching || selfieCam !== "live"}>
                  <Icon name="camera" size={17} />{t("takeSelfie")}
                </button>
              )}
            </div>
            <div className="gcenter-txt">
              <h3>{t("stillOnDuty")}</h3>
              <p>{faceVerdict === "pass" ? t("faceOk")
                 : faceVerdict === "no_face" ? t("faceNone")
                 : faceVerdict ? t("faceReview") : t("randomCheckWhy")}</p>
            </div>
          </div>
          <div className="gfoot">
            <button className="gbtn ghost narrow" onClick={submitRandomCheck}>{t("notNow")}</button>
            <button className="gbtn primary" disabled={!photo || matching}
                    onClick={submitRandomCheck}>{t("done")}</button>
          </div>
        </>
      )}

      {screen === "settings" && (
        <>
          <Bar t={t} title={t("settings")} left={<BackBtn onClick={() => setScreen(shiftId ? "today" : "pin")} />} />
          <div className="gbody">
            <div className="gswitch">
              <span>{t("nightMode")}</span>
              <button className="gtog" aria-pressed={night} onClick={() => {
                setNight((n) => { localStorage.setItem("gate.night", n ? "0" : "1"); return !n; });
              }} aria-label={t("nightMode")} />
            </div>
            <h3 className="ghead">{t("language")}</h3>
            <div className="glangs">
              {LANGS.map((l) => (
                <button key={l.id} className="glang" aria-pressed={lang === l.id}
                  onClick={() => { setLang(l.id); localStorage.setItem("gate.lang", l.id); }}>
                  <span className="native">{l.native}</span>
                  <span className="en">{l.en}</span>
                  <span className="chk">✓</span>
                </button>
              ))}
            </div>
            <SyncCard t={t} online={online} queue={queue} />
            <div style={{ height: 10 }} />
            <button className="gbtn sm ghost" onClick={() => {
              // Handover. The queue is deliberately NOT cleared: those rows
              // belong to the guard who made them and still have to be sent.
              clearGuardId(); setMe(null); setShiftId(null); setShiftAt(null);
              setScreen("who");
            }}>{t("switchGuard")}</button>
          </div>
        </>
      )}
      {/* ── Confirming a removal ─────────────────────────────────────────
          Above every screen, because both the scanning feed and the close
          screen open it. It names the item being removed rather than asking
          "are you sure?" about nothing in particular -- on a phone held at
          arm's length next to a truck, that difference is the whole safeguard.
          The safe choice is the wide one and it is on the left, where a thumb
          reaching to dismiss lands first. */}
      {confirmRemove && (
        <div className="gsheet" role="dialog" aria-modal="true">
          <div className="gsheetbox">
            <h3>{t("removeItem")}</h3>
            <div className="gcard warn col">
              <div className="mono big">{confirmRemove.barcode}</div>
              {confirmRemove.label && <span className="gsub">{confirmRemove.label}</span>}
            </div>
            <p>{t("removeWhy")}</p>
            <div className="grow2">
              <button className="gbtn ghost" onClick={() => setConfirmRemove(null)}>
                {t("keepIt")}
              </button>
              <button className="gbtn warn" onClick={() => void removeLine(confirmRemove)}>
                <Icon name="delete" size={17} />{t("remove")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── small pieces ────────────────────────────────────────────────────── */
const KIND_LABEL: Record<outbox.Kind, string> = {
  trip: "kindTrip", scan: "kindScan", shift: "kindShift", face: "kindFace",
  void: "removed",
};
const when = (ms: number) => {
  const mins = Math.round((Date.now() - ms) / 60000);
  return mins < 1 ? "just now" : mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
};

const fmt = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function Center({ children }: { children: React.ReactNode }) {
  return <div className="gcenter">{children}</div>;
}
function Bar({ title, left, right }: { t: (k: string) => string; title: string; left?: React.ReactNode; right?: React.ReactNode }) {
  return <div className="gbar">{left}<h2>{title}</h2>{right}</div>;
}
function BackBtn({ onClick }: { onClick: () => void }) {
  return <button className="gicon" onClick={onClick} aria-label="Back"><Icon name="chevron_left" size={22} /></button>;
}
function GearBtn({ onClick }: { onClick: () => void }) {
  return <button className="gicon" onClick={onClick} aria-label="Settings"><Icon name="settings" size={20} /></button>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="gfld"><span>{label}</span>{children}</label>;
}
/**
 * Choose from today's list, or type it in.
 *
 * The escape hatch is not decoration. A truck substituted an hour ago is not
 * in DT yet, a hired vehicle may never be, and DT itself can be unreachable —
 * in every one of those cases something is physically at the gate and has to
 * be recorded. A picker that could only pick would send the guard to the paper
 * register, which is the outcome this whole app exists to prevent.
 *
 * So the list is the default and typing is one tap away, never the reverse.
 * Three states, and they are deliberately distinguishable:
 *
 *   options === null    still loading — a short wait, not a failure
 *   unavailable         DT could not be reached; typing, and we say why
 *   options === []      DT answered, nothing is scheduled; typing
 */
function Picker({ t, label, hint, options, unavailable, value, onChange,
                  typing, onTyping, mono, uppercase, placeholder }: {
  t: (k: string) => string;
  label: string; hint: string;
  options: string[] | null;
  unavailable: boolean;
  value: string;
  onChange: (v: string) => void;
  typing: boolean;
  onTyping: (v: boolean) => void;
  mono?: boolean; uppercase?: boolean; placeholder?: string;
}) {
  const [filter, setFilter] = useState("");
  const loading = options === null;
  const empty = !loading && options.length === 0;
  // Once there is nothing to pick from, typing is the only option and offering
  // a way "back to the list" would be a lie.
  const listMode = !typing && !loading && !empty;

  const shown = listMode
    ? options.filter((o) => o.toLowerCase().includes(filter.trim().toLowerCase()))
    : [];

  return (
    <Field label={label}>
      {loading && (
        <div className="gpickload">
          <Icon name="progress_activity" size={17} className="gspinicon" />
          <span>{t("starting")}</span>
        </div>
      )}

      {listMode && (
        <>
          {/* Only worth showing once the list is long enough to scroll past
              what a thumb can reach. Below that it is a box in the way. */}
          {options.length > 8 && (
            <input className={`gf gpickfilter${mono ? " mono" : ""}`} value={filter}
                   placeholder={hint} autoComplete="off"
                   onChange={(e) => setFilter(e.target.value)} />
          )}
          <div className="gpicklist">
            {shown.map((o) => (
              <button key={o} type="button"
                      className={`gpickopt${value === o ? " on" : ""}${mono ? " mono" : ""}`}
                      onClick={() => onChange(o)}>
                {o}
                {value === o && <Icon name="check" size={16} />}
              </button>
            ))}
            {shown.length === 0 && <p className="gnote">{t("noFleetYet")}</p>}
          </div>
          <button type="button" className="gbtn sm ghost"
                  onClick={() => { onTyping(true); onChange(""); }}>
            {t("typeItIn")}
          </button>
        </>
      )}

      {!listMode && !loading && (
        <>
          <input className={`gf${mono ? " mono" : ""}`} value={value} placeholder={placeholder}
                 autoComplete="off"
                 autoCapitalize={uppercase ? "characters" : undefined}
                 onChange={(e) => onChange(uppercase ? e.target.value.toUpperCase() : e.target.value)} />
          {unavailable && <p className="gnote">{t("noFleetYet")}</p>}
          {typing && !empty && (
            <button type="button" className="gbtn sm ghost" onClick={() => onTyping(false)}>
              {t("backToList")}
            </button>
          )}
        </>
      )}
    </Field>
  );
}

/**
 * The item photo: a square viewfinder with a shutter under it.
 *
 * It was one tall button that opened the camera on the first tap and captured
 * on the second, with no way back — a guard who blinked had to abandon the
 * whole entry and start again. Three things changed and each earns its place:
 *
 *   SQUARE      a phone camera preview is not the shape of a wide, short box,
 *               so the old one cropped hard and showed a slice of the item.
 *               1:1 is what the guard actually gets.
 *   A SHUTTER   a separate, labelled button. The frame shows what will be
 *               captured; the button captures it. Neither pretends to be the
 *               other.
 *   RETAKE      always available once a shot exists. Blurred, dark, wrong box —
 *               all one tap to fix, and all previously required cancelling.
 *
 * These photos are the only evidence a manual entry or an override carries, so
 * a guard being able to see and redo one is not a nicety.
 */
function PhotoBox({ t, photo, url, cam, videoRef, onOpen, onShoot, onRetake }: {
  t: (k: string) => string;
  photo: Blob | null;
  /** Object URL of the captured frame, so the guard sees what they took. */
  url: string | null;
  cam: "off" | "starting" | "live" | "blocked";
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onOpen: () => void;
  onShoot: () => void;
  onRetake: () => void;
}) {
  return (
    <div className="gphotowrap">
      <div className={`gphotoframe${photo ? " done" : ""}${cam === "live" ? " live" : ""}`}>
        <video ref={videoRef} playsInline muted autoPlay
               className={cam === "live" && !url ? "" : "hidden"} />
        {/* eslint-disable-next-line @next/next/no-img-element -- a local blob;
            next/image cannot take an object URL. */}
        {url && <img src={url} alt="" />}
        {!url && cam !== "live" && (
          <div className="gphotoempty">
            <Icon name={cam === "starting" ? "progress_activity" : "camera"}
                  size={34} className={cam === "starting" ? "gspinicon" : ""} />
            <span>{cam === "blocked" ? t("cameraBlocked")
                 : cam === "starting" ? t("starting") : t("photoNeeded")}</span>
          </div>
        )}
        {/* Corner marks, the same language as the scanner's reticle, so the
            square reads as a viewfinder rather than an empty card. */}
        {!url && <div className="gretic sm"><i /><i /><i /><i /></div>}
      </div>

      <div className="gphotobtns">
        {photo ? (
          <button className="gbtn sm ghost" onClick={onRetake}>
            <Icon name="refresh" size={17} />{t("retake")}
          </button>
        ) : cam === "live" ? (
          <button className="gbtn sm primary" onClick={onShoot}>
            <Icon name="camera" size={17} />{t("takePicture")}
          </button>
        ) : (
          <button className="gbtn sm primary" onClick={onOpen} disabled={cam === "starting"}>
            <Icon name="camera" size={17} />
            {cam === "blocked" ? t("cameraBlocked") : t("takePicture")}
          </button>
        )}
      </div>
    </div>
  );
}
function GeoCard({ t, boot }: { t: (k: string) => string; boot: Bootstrap | null }) {
  return (
    <div className="gcard">
      <Icon name="location_on" size={22} className="gbig" />
      <div><b>{t("atGate")}</b><span>{boot?.site?.label ?? "—"}</span></div>
    </div>
  );
}
function SyncCard({ t, online, queue }: {
  t: (k: string) => string; online: boolean;
  queue: { waiting: number; rejected: number };
}) {
  // Offline is stated plainly and framed as SAFE, not as an error. A guard who
  // thinks their work is being lost starts keeping a paper backup, and then
  // there are two registers again.
  const clean = online && queue.waiting === 0 && queue.rejected === 0;
  return (
    <div className={`gcard ${clean ? "ok" : "warn"}`}>
      <Icon name={clean ? "check_circle" : online ? "sync" : "wifi_off"} size={22} className="gbig" />
      <div>
        <b>{clean ? t("allSent") : !online ? t("offline") : `${queue.waiting} ${t("waiting")}`}</b>
        {queue.rejected > 0 && <span>{queue.rejected} {t("needsAttention")}</span>}
      </div>

    </div>
  );
}
