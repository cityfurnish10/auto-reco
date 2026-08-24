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

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/icon";
import { LANGS, makeT, type LangId } from "@/lib/gate/client/i18n";
import * as outbox from "@/lib/gate/client/outbox";
import { bootstrap, clearGuardId, drain, getGuardId, getToken, rosterFor, signIn,
         type Bootstrap, type GuardOption } from "@/lib/gate/client/api";
import { compress, feedback, position } from "@/lib/gate/client/media";
import { decodeFrame, initScanner, openCamera, stopCamera } from "@/lib/gate/client/scanner";
import { canonicalize } from "@/lib/engine/barcode";
import { compare, describe as describeFace, fromArray, initFace } from "@/lib/gate/client/face";

type Screen =
  | "loading" | "unpaired" | "who" | "pin" | "checkin" | "today"
  | "newtrip" | "scan" | "resolve" | "manual" | "closetrip" | "settings"
  // The two that decide whether a guard trusts the app when it is not
  // behaving: what went wrong, and what is still waiting to be sent.
  | "problem" | "queue" | "profile";

interface ScanLine {
  clientId: string; barcode: string; label: string; flagged: boolean;
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
  const [rejected, setRejected] = useState<outbox.OutboxItem[]>([]);
  const [pendingItems, setPendingItems] = useState<outbox.OutboxItem[]>([]);
  // The gate's roster and the guard who has signed in on this phone. A device
  // serves whoever is on shift, so this is per-session rather than per-device.
  const [roster, setRoster] = useState<GuardOption[]>([]);
  const [me, setMe] = useState<GuardOption | null>(null);
  // The live face signature and what it scored against this guard's stored one.
  const selfieRef = useRef<HTMLVideoElement>(null);
  const selfieStream = useRef<MediaStream | null>(null);
  const [selfieCam, setSelfieCam] = useState<"starting" | "live" | "blocked">("starting");
  const [shotUrl, setShotUrl] = useState<string | null>(null);
  const [faceScore, setFaceScore] = useState<number | null>(null);
  const [faceVerdict, setFaceVerdict] = useState<"pass" | "review" | "fail" | "no_face" | null>(null);
  const [matching, setMatching] = useState(false);

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

      let token: string | null = null;
      try { token = getToken(); } catch { /* storage blocked */ }
      if (!token) { setScreen("unpaired"); return; }

      // The queue lives in IndexedDB, which a locked-down browser can refuse
      // outright. That must not stop the app opening.
      try { await refreshQueue(); } catch { /* shown as zero until it recovers */ }

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
  }, [refreshQueue]);

  /* ── background sync ───────────────────────────────────────────────── */
  const sync = useCallback(async () => {
    const r = await drain();
    setOnline(!r.offline);
    await refreshQueue();
    return r;
  }, [refreshQueue]);

  // ~6.7MB of weights. Loaded while the guard is on the PIN pad so the pause
  // lands where they are already typing, not after they have taken the selfie.
  useEffect(() => {
    if (screen === "pin" || screen === "checkin") void initFace().catch(() => {});
  }, [screen]);

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
    if (screen !== "checkin") {
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
  }, [screen]);

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
      const match = boot?.expected.find(
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

  const stampElapsed = () =>
    setElapsed(t0 ? `${Math.max(1, Math.round((Date.now() - t0) / 60000))}m` : "—");

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
      const next = [{ clientId, barcode: bc, label, flagged }, ...l];
      if (t0) setRate(`${((Date.now() - t0) / 1000 / next.length).toFixed(1)}s`);
      return next;
    });
    await refreshQueue();
    void sync();
  }

  // Point the loop at the latest closure AFTER each render, not during one —
  // a ref written while rendering is a side effect in the render path.
  useEffect(() => { onDecodedRef.current = onDecoded; });

  /* ── the check-in selfie ───────────────────────────────────────────────── */
  async function takeSelfie() {
    const v = selfieRef.current;
    // videoWidth is 0 until the first frame has actually arrived. Checking it
    // is what makes this reliable where a timer was not.
    if (!v?.videoWidth) return;
    setMatching(true);
    try {
      const blob = await compress(v, 640, 0.75);
      setPhoto(blob);
      setShotUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(blob); });
      // The comparison runs here, on the phone. Nothing is uploaded to decide it.
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
  }

  /* ── capture a photo from the live camera ──────────────────────────── */
  async function grabPhoto() {
    if (!videoRef.current?.videoWidth) return;
    setPhoto(await compress(videoRef.current));
  }

  /* ── trip ──────────────────────────────────────────────────────────── */
  async function startTrip() {
    if (!dir || veh.trim().length < 4) return;
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
    setT0(Date.now()); await refreshQueue(); void sync();
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
      },
    });
    setTrips((n) => n + 1);
    setItemsToday((n) => n + lines.length);
    setTripId(null); setDir(null); setVeh(""); setDrv("");
    setLines([]); seenRef.current = new Set();
    await refreshQueue(); void sync(); setScreen("today");
  }

  /* ── attendance ────────────────────────────────────────────────────── */
  async function doCheckIn() {
    const clientId = uid();
    const pos = await position();
    await outbox.enqueue({
      clientId, kind: "shift",
      payload: {
        clientShiftId: clientId, checkedInAt: new Date().toISOString(), status: "open",
        inLat: pos?.coords.latitude ?? null, inLng: pos?.coords.longitude ?? null,
      },
    });
    // The selfie is captured and queued; the on-device face match will attach
    // its score here. Until that model ships, the verdict is 'review' so a
    // human still sees it rather than it silently passing.
    const faceId = uid();
    await outbox.enqueue({
      clientId: faceId, kind: "face",
      payload: {
        clientCheckId: faceId, clientShiftId: clientId, trigger: "check_in",
        capturedAt: new Date().toISOString(),
        // The on-device verdict. Anything short of a clean pass goes to a
        // manager to glance at — it never stops the guard working.
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
            <SyncCard t={t} online={online} queue={queue} onSync={() => void sync()} />

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
            <button className="gbtn ghost" onClick={() => {
              // Handover. The queue is NOT cleared: those rows belong to the
              // guard who made them and still have to be sent under their name.
              clearGuardId(); setMe(null); setShiftId(null); setShiftAt(null);
              setScreen("who");
            }}>{t("switchGuard")}</button>
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
            <SyncCard t={t} online={online} queue={queue} onSync={() => void sync()} />
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
    </div>
  );
}

/* ── small pieces ────────────────────────────────────────────────────── */
const KIND_LABEL: Record<outbox.Kind, string> = {
  trip: "kindTrip", scan: "kindScan", shift: "kindShift", face: "kindFace",
};
const when = (ms: number) => {
  const mins = Math.round((Date.now() - ms) / 60000);
  return mins < 1 ? "just now" : mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
};

const fmt = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

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
function PhotoBox({ t, photo, onClick }: { t: (k: string) => string; photo: Blob | null; onClick: () => void }) {
  return (
    <button className={`gphoto${photo ? " done" : ""}`} onClick={onClick}>
      <Icon name={photo ? "check_circle" : "camera"} size={30} />
      <span>{photo ? t("photoTaken") : t("photoRequired")}</span>
    </button>
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
function SyncCard({ t, online, queue, onSync }: {
  t: (k: string) => string; online: boolean;
  queue: { waiting: number; rejected: number }; onSync: () => void;
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
      {!clean && online && <button className="gbtn sm ghost" onClick={onSync}>{t("syncNow")}</button>}
    </div>
  );
}
