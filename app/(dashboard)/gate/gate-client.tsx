"use client";

// The Gate section — one destination with four tabs, rather than five sidebar
// entries. The sidebar was already at ten items; adding the gate work as
// separate rows would have pushed it to fifteen, which is past the point anyone
// scans a list instead of hunting it.
//
// The paper register lives in here too, as one of the tabs, and only shows for
// cities not yet on the app. That makes the pilot legible: a manager can see at
// a glance which cities scan and which still upload a PDF.

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { Modal } from "@/components/modal";
import { CITIES } from "@/lib/sample-data";
import type { SessionUser } from "@/lib/demo-auth";

type Tab = "activity" | "guards" | "devices" | "gates" | "reviews";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "activity", label: "Activity", icon: "dashboard" },
  { id: "guards", label: "Guards", icon: "group" },
  { id: "devices", label: "Devices", icon: "upload_file" },
  { id: "gates", label: "Gates", icon: "location_on" },
  { id: "reviews", label: "Reviews", icon: "pending_actions" },
];

export default function GateClient({ user }: { user: SessionUser }) {
  const [tab, setTab] = useState<Tab>("activity");
  return (
    <section className="p-container-margin space-y-6">
      <header>
        <h1 className="font-headline text-xl text-text-primary mb-1">Gate</h1>
        <p className="text-text-muted text-sm">
          What the gate recorded, who is on duty, and anything waiting on a decision.
        </p>
      </header>

      <div className="bg-surface-elevated rounded-control p-1 flex flex-wrap gap-1">
        {TABS.map((x) => (
          <button key={x.id} onClick={() => setTab(x.id)}
            className={tab === x.id
              ? "px-4 py-1.5 text-sm font-medium rounded-control bg-surface-card shadow-card flex items-center gap-2"
              : "px-4 py-1.5 text-sm text-text-secondary rounded-control hover:bg-surface-card transition-colors duration-150 flex items-center gap-2"}>
            <Icon name={x.icon as never} size={16} />{x.label}
          </button>
        ))}
      </div>

      {tab === "activity" && <Activity user={user} />}
      {tab === "guards" && <Guards user={user} />}
      {tab === "devices" && <Devices user={user} />}
      {tab === "gates" && <Gates />}
      {tab === "reviews" && <Reviews />}
    </section>
  );
}

/* ── Activity ───────────────────────────────────────────────────────── */
interface TripItem {
  id: string; barcode: string | null; serialNo: string | null; product: string | null;
  soNumber: string | null; itemKind: string; quantity: number; entryMethod: string;
  override: string | null; exception: string | null; awaitingBarcode: boolean;
  geoOk: boolean | null; hasPhoto: boolean; scannedAt: string;
}
interface Trip {
  id: string; direction: string; vehicleNo: string; driverName: string | null;
  carrierRef: string | null; city: string; siteCode: string;
  openedAt: string; closedAt: string | null; status: string; durationSec: number | null;
  guardName: string; itemCount: number; overrides: number; manual: number; items: TripItem[];
}
interface ActivityData {
  businessDate: string;
  totals: { trips: number; items: number; scanned: number; manual: number;
            overrides: number; awaitingBarcode: number; scannedShare: number | null };
  guards: { id: string; name: string }[];
  trips: Trip[];
}

const today = () => new Date().toISOString().slice(0, 10);

function Activity({ user }: { user: SessionUser }) {
  const [d, setD] = useState<ActivityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Trip | null>(null);

  // Filters. Date first because it is the one always used; a manager is pinned
  // to their own city so that filter only appears for an admin.
  const [date, setDate] = useState(today());
  const [city, setCity] = useState<string>(user.city ?? "");
  const [guardId, setGuardId] = useState("");
  const [direction, setDirection] = useState("");

  const load = useCallback(() => {
    const q = new URLSearchParams({ date });
    if (city) q.set("city", city);
    if (guardId) q.set("guardId", guardId);
    if (direction) q.set("direction", direction);
    fetch(`/api/gate/activity?${q}`, { credentials: "same-origin" })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        return j;
      })
      .then((j) => { setLoadErr(null); setD(j); })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [date, city, guardId, direction]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-5">
      {/* One row, wrapping. Every control the same height so the row reads as a
          single band rather than a jumble of differently sized boxes. */}
      <div className="card p-3 flex flex-wrap gap-2 items-center">
        <input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)}
          className="h-9 px-2 rounded-control border border-border bg-surface-card text-sm" />
        {!user.city && (
          <select value={city} onChange={(e) => setCity(e.target.value)}
            className="h-9 px-2 rounded-control border border-border bg-surface-card text-sm">
            <option value="">All cities</option>
            {CITIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        <select value={guardId} onChange={(e) => setGuardId(e.target.value)}
          className="h-9 px-2 rounded-control border border-border bg-surface-card text-sm">
          <option value="">All guards</option>
          {(d?.guards ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <select value={direction} onChange={(e) => setDirection(e.target.value)}
          className="h-9 px-2 rounded-control border border-border bg-surface-card text-sm">
          <option value="">In and out</option>
          <option value="IN">Inward</option>
          <option value="OUT">Outward</option>
        </select>
        {(guardId || direction || (!user.city && city)) && (
          <button className="btn btn-compact btn-secondary"
            onClick={() => { setGuardId(""); setDirection(""); setCity(user.city ?? ""); }}>
            Clear
          </button>
        )}
        <span className="ml-auto text-xs text-text-muted">{d?.businessDate ?? date}</span>
      </div>

      {loadErr && <LoadError what="gate activity" detail={loadErr} onRetry={load} />}
      {loading && !d && <p className="text-text-muted text-sm">Loading…</p>}

      {d && !loadErr && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Trips" value={d.totals.trips} />
            <Stat label="Items" value={d.totals.items} />
            {/* The number the pilot is judged on. Amber below 80% because a
                falling share means guards are working around the scanner. */}
            <Stat label="Scanned" value={d.totals.scannedShare === null ? "—" : `${d.totals.scannedShare}%`}
                  tone={d.totals.scannedShare !== null && d.totals.scannedShare < 80 ? "warn" : "ok"} />
            <Stat label="Overrides" value={d.totals.overrides}
                  tone={d.totals.overrides > 0 ? "warn" : "ok"} />
          </div>

          {d.totals.awaitingBarcode > 0 && (
            <div className="card p-4 border border-warning/30 text-sm">
              <b>{d.totals.awaitingBarcode}</b> item{d.totals.awaitingBarcode === 1 ? "" : "s"} awaiting a barcode.
            </div>
          )}

          {d.trips.length === 0 ? <Empty text="No trips recorded for these filters." /> : (
            <div className="card overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    {["Guard", "Vehicle", "Direction", "Items", "Opened", "Took", "Status"].map((h) => (
                      <th key={h} className="text-left px-4 py-2.5 text-xs uppercase tracking-wide text-text-muted whitespace-nowrap">{h}</th>
                    ))}
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {d.trips.map((tr) => (
                    <tr key={tr.id} onClick={() => setOpen(tr)}
                        className="border-t border-border hover:bg-surface-elevated cursor-pointer transition-colors duration-150">
                      <td className="px-4 py-2.5 font-medium text-text-primary whitespace-nowrap">{tr.guardName || "—"}</td>
                      <td className="px-4 py-2.5 font-mono whitespace-nowrap">{tr.vehicleNo}</td>
                      <td className="px-4 py-2.5">
                        <span className={`badge ${tr.direction === "OUT" ? "badge-medium" : "badge-info"}`}>
                          {tr.direction === "OUT" ? "Outward" : "Inward"}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 tabular-nums">
                        {tr.itemCount}
                        {tr.overrides > 0 && <span className="badge badge-high ml-2">{tr.overrides} override</span>}
                      </td>
                      <td className="px-4 py-2.5 text-text-secondary whitespace-nowrap">{clock(tr.openedAt)}</td>
                      <td className="px-4 py-2.5 text-text-secondary whitespace-nowrap tabular-nums">{took(tr.durationSec)}</td>
                      <td className="px-4 py-2.5">
                        <span className={`badge ${tr.status === "closed" ? "badge-done" : "badge-info"}`}>{tr.status}</span>
                      </td>
                      <td className="px-2 text-text-muted"><Icon name="chevron_right" size={17} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <TripModal trip={open} onClose={() => setOpen(null)} />
    </div>
  );
}

/** Everything about one trip, including the items the table only counts. */
function TripModal({ trip, onClose }: { trip: Trip | null; onClose: () => void }) {
  if (!trip) return null;
  return (
    <Modal open onClose={onClose}
      title={`${trip.vehicleNo} · ${trip.direction === "OUT" ? "Outward" : "Inward"}`}
      subtitle={`${trip.guardName} · ${trip.city}`} size="lg">
      <div className="grid sm:grid-cols-2 gap-x-8 mb-5">
        <Row k="Guard" v={trip.guardName || "—"} />
        <Row k="Delivery agent" v={trip.driverName ?? "—"} />
        <Row k="Opened" v={clock(trip.openedAt)} mono />
        <Row k="Closed" v={trip.closedAt ? clock(trip.closedAt) : "still open"} mono />
        <Row k="Took" v={took(trip.durationSec)} mono />
        <Row k="Items" v={`${trip.itemCount}${trip.manual ? ` · ${trip.manual} typed` : ""}`} />
      </div>

      {trip.items.length === 0 ? <Empty text="No items on this trip." /> : (
        <div className="overflow-x-auto border border-border rounded-control">
          <table className="w-full text-sm">
            <thead>
              <tr>
                {["Barcode", "Item", "Kind", "Qty", "How", "Time"].map((h) => (
                  <th key={h} className="text-left px-3 py-2 text-xs uppercase tracking-wide text-text-muted whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trip.items.map((it) => (
                <tr key={it.id} className="border-t border-border">
                  {/* Raw scanned spelling — never the fold. */}
                  <td className="px-3 py-2 font-mono">{it.barcode ?? it.serialNo ?? "—"}</td>
                  <td className="px-3 py-2">{it.product ?? "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{it.itemKind.replace(/_/g, " ")}</td>
                  <td className="px-3 py-2 tabular-nums">{it.quantity}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className={`badge ${it.entryMethod === "scan" ? "badge-done" : "badge-medium"}`}>
                      {it.entryMethod}
                    </span>
                    {it.override && <span className="badge badge-high ml-1" title={it.override}>override</span>}
                    {it.awaitingBarcode && <span className="badge badge-medium ml-1">no barcode</span>}
                    {it.hasPhoto && <Icon name="camera" size={13} className="inline ml-1 text-text-muted" />}
                  </td>
                  <td className="px-3 py-2 text-text-secondary whitespace-nowrap">{clock(it.scannedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

/* ── Guards ─────────────────────────────────────────────────────────── */
interface GuardRow {
  guardId: string; name: string; city: string; employeeCode: string | null;
  phone: string | null; status: string; hasReferencePhoto: boolean;
  consentAt: string | null;
  referencePhotoUrl: string | null;
}

function Guards({ user }: { user: SessionUser }) {
  const [rows, setRows] = useState<GuardRow[]>([]);
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [viewing, setViewing] = useState<GuardRow | null>(null);

  const [loadErr, setLoadErr] = useState<string | null>(null);
  const load = useCallback(() => {
    fetch("/api/gate/guards", { credentials: "same-origin" })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        return j;
      })
      .then((j) => { setLoadErr(null); setRows(j.guards ?? []); })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-text-muted text-sm">
          A guard signs in by name and PIN on any phone at their gate.
        </p>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>Add guard</button>
      </div>
      {msg && <div className="card p-3 text-sm">{msg}</div>}
      {loadErr && <LoadError what="guards" detail={loadErr} onRetry={load} />}
      {!loadErr && rows.length === 0 && <Empty text="No guards yet." />}
      {!loadErr && rows.length > 0 && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                {/* Left-aligned throughout, with the face beside the name. A
                    centred column of four-digit codes reads as decoration; the
                    eye scans a left edge. */}
                <th className="text-left px-4 py-2.5 text-xs uppercase tracking-wide text-text-muted">Guard</th>
                <th className="text-left px-4 py-2.5 text-xs uppercase tracking-wide text-text-muted">Code</th>
                <th className="text-left px-4 py-2.5 text-xs uppercase tracking-wide text-text-muted">City</th>
                <th className="text-left px-4 py-2.5 text-xs uppercase tracking-wide text-text-muted">Face</th>
                <th className="text-left px-4 py-2.5 text-xs uppercase tracking-wide text-text-muted">Status</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.guardId} className="border-t border-border hover:bg-surface-elevated
                                               cursor-pointer transition-colors duration-150"
                    onClick={() => setViewing(g)}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      <Avatar url={g.referencePhotoUrl} name={g.name} />
                      <span className="font-medium text-text-primary">{g.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 font-mono tabular-nums text-text-secondary">
                    {g.employeeCode ?? "—"}</td>
                  <td className="px-4 py-2.5 text-text-secondary">{g.city}</td>
                  <td className="px-4 py-2.5">
                    <span className={`badge ${g.hasReferencePhoto ? "badge-done" : "badge-medium"}`}>
                      {g.hasReferencePhoto ? "enrolled" : "not yet"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`badge ${g.status === "active" ? "badge-done" : "badge-suppressed"}`}>
                      {g.status}</span>
                  </td>
                  <td className="px-2 text-text-muted"><Icon name="chevron_right" size={17} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <GuardDetail guard={viewing} onClose={() => setViewing(null)} onChanged={load} />

      {adding && <AddGuard user={user} onDone={(m) => { setAdding(false); setMsg(m); load(); }} />}
    </div>
  );
}

/**
 * Adding a guard, and the one thing that makes it more than a form: the face
 * descriptor is computed HERE, in this browser, from the photo just taken. The
 * phone never receives a photograph of anybody — only 128 numbers.
 */
function AddGuard({ user, onDone }: { user: SessionUser; onDone: (msg: string) => void }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  // Same reasoning as Devices: an admin has no city of their own to fall back on.
  const [city, setCity] = useState<string>(user.city ?? "");
  const [busy, setBusy] = useState(false);
  const [shot, setShot] = useState<{ blob: Blob; descriptor: number[]; url: string } | null>(null);
  // The 6.7MB face model. Loaded when the form opens rather than on the first
  // capture, so the wait lands while the manager is typing a name instead of
  // after they press a button and nothing happens.
  const [model, setModel] = useState<"loading" | "ready">("loading");

  // Keep the viewable still with its blob and revoke the previous one here, so
  // a manager retaking a photo five times does not leak five object URLs.
  const keepShot = (blob: Blob, descriptor: number[]) => {
    setShot((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return { blob, descriptor, url: URL.createObjectURL(blob) };
    });
  };
  const [err, setErr] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Say which of the three states we are in. A blank circle tells the operator
  // nothing — they cannot know whether to wait, grant permission, or give up.
  const [cam, setCam] = useState<"starting" | "live" | "blocked">("starting");

  useEffect(() => {
    void (async () => {
      const { initFace } = await import("@/lib/gate/client/face");
      await initFace().catch(() => {});
      setModel("ready");
    })();
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) { setCam("blocked"); return; }
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
        if (!live) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setCam("live");
      } catch {
        setCam("blocked");
      }
    })();
    return () => { live = false; streamRef.current?.getTracks().forEach((t) => t.stop()); };
  }, []);

  async function readPhotoFile(file: File) {
    setBusy(true); setErr(null);
    try {
      const { describe, toArray } = await import("@/lib/gate/client/face");
      const img = document.createElement("img");
      img.src = URL.createObjectURL(file);
      await new Promise((r) => { img.onload = r; img.onerror = r; });
      const d = await describe(img);
      URL.revokeObjectURL(img.src);
      if (!d) { setErr("No face found in that photo. Try one taken straight on, in good light."); return; }
      keepShot(file, toArray(d));
    } finally { setBusy(false); }
  }

  async function capture() {
    if (!videoRef.current) return;
    setBusy(true); setErr(null);
    try {
      const { compress } = await import("@/lib/gate/client/media");
      const { describe, toArray } = await import("@/lib/gate/client/face");
      const blob = await compress(videoRef.current, 640, 0.8);
      const d = await describe(videoRef.current);
      if (!d) { setErr("No face found — try again in better light, looking straight at the camera."); return; }
      keepShot(blob, toArray(d));
    } finally { setBusy(false); }
  }

  const save = () => doSave(false);
  const saveConfirmed = () => doSave(true);

  async function doSave(confirmDuplicateName: boolean): Promise<void> {
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/gate/guards", {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name, city, pin, employeeCode: code || undefined,
                               descriptor: shot?.descriptor, confirmDuplicateName }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 409 && j.duplicateName) {
        // A shared name is possible, so this asks rather than refuses.
        if (!window.confirm(`${j.error}\n\nAdd them anyway?`)) return;
        return saveConfirmed();
      }
      if (!res.ok) { setErr(j.error ?? `Could not add the guard (HTTP ${res.status})`); return; }
      // The photo itself goes straight to storage, for human review only.
      if (shot && j.referencePhotoUpload) {
        const { getSupabaseClient } = await import("@/lib/supabase/client");
        await getSupabaseClient().storage
          .from(j.referencePhotoUpload.bucket)
          .uploadToSignedUrl(j.referencePhotoUpload.path, j.referencePhotoUpload.token, shot.blob)
          .catch(() => {});
      }
      onDone(`${name} added.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not reach the server.");
    } finally { setBusy(false); }
  }

  return (
    <div className="card p-5 space-y-4">
      <h3 className="font-headline text-lg">Add guard</h3>
      {err && <p className="text-danger text-sm">{err}</p>}
      <div className="grid md:grid-cols-4 gap-3">
        {!user.city && (
          <label className="text-sm">City
            <select className="w-full mt-1 h-10 px-3 rounded-control border border-border bg-surface-card"
              value={city} onChange={(e) => setCity(e.target.value)}>
              <option value="">Choose…</option>
              {CITIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        )}
        <label className="text-sm">Name
          <input className="w-full mt-1 h-10 px-3 rounded-control border border-border bg-surface-card"
            value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="text-sm">Employee code
          <input className="w-full mt-1 h-10 px-3 rounded-control border border-border bg-surface-card"
            value={code} onChange={(e) => setCode(e.target.value)} /></label>
        <label className="text-sm">PIN (4–6 digits)
          <input className="w-full mt-1 h-10 px-3 rounded-control border border-border bg-surface-card font-mono"
            value={pin} inputMode="numeric" onChange={(e) => setPin(e.target.value)} /></label>
      </div>

      <div className="flex gap-4 items-center flex-wrap">
        <div className="relative w-40 h-40 rounded-full overflow-hidden bg-surface-elevated
                        grid place-items-center flex-none border border-border">
          <video ref={videoRef} playsInline muted autoPlay
            className={`absolute inset-0 w-full h-full object-cover ${cam === "live" ? "" : "opacity-0"}`} />
          {cam !== "live" && !shot && (
            <Icon name={cam === "blocked" ? "camera" : "progress_activity"} size={30}
                  className={`text-text-muted ${cam === "starting" ? "animate-spin" : ""}`} />
          )}
          {/* eslint-disable-next-line @next/next/no-img-element -- a local blob
              preview; next/image cannot handle an object URL. */}
          {shot && <img src={shot.url} alt="Captured face"
                           className="absolute inset-0 w-full h-full object-cover" />}
          {shot && (
            <span className="absolute bottom-1 right-1 w-7 h-7 rounded-full bg-success
                             text-white grid place-items-center shadow">
              <Icon name="check" size={16} />
            </span>
          )}
        </div>

        {/* Two ways in, nothing else. Upload is not a fallback for a broken
            camera so much as the equal option — a manager enrolling five guards
            from existing photos should not have to line each one up. */}
        <div className="flex flex-col gap-2">
          <button className="btn btn-secondary" onClick={capture}
            disabled={busy || cam !== "live" || model === "loading"}>
            <Icon name="camera" size={17} />
            {model === "loading" ? "Preparing…" : busy ? "Reading face…"
              : shot ? "Retake photo" : "Take photo"}
          </button>
          <label className={`btn btn-secondary ${busy ? "opacity-60" : "cursor-pointer"}`}>
            <Icon name="cloud_upload" size={17} />Upload photo
            <input type="file" accept="image/*" className="hidden"
              disabled={busy || model === "loading"}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void readPhotoFile(f); }} />
          </label>
        </div>
      </div>

      <div className="flex gap-2 items-center flex-wrap">
        <button className="btn btn-primary"
          disabled={busy || !name || !city || !/^\d{4,6}$/.test(pin) || !shot}
          onClick={save}>{busy ? "Saving…" : "Save guard"}</button>
        <button className="btn btn-secondary" onClick={() => onDone("")}>Cancel</button>
        {err && <span className="text-danger text-sm">{err}</span>}
        {/* Say what is still missing, rather than leaving a greyed-out button
            with no explanation of what would un-grey it. */}
        {!busy && !err && (!name || !city || !shot || !/^\d{4,6}$/.test(pin)) && (
          <span className="text-text-muted text-sm">
            Needs {[!city && "a city", !name && "a name",
                    !/^\d{4,6}$/.test(pin) && "a 4–6 digit PIN",
                    !shot && "a photo"].filter(Boolean).join(", ")}
          </span>
        )}
      </div>
    </div>
  );
}

/* ── Devices ────────────────────────────────────────────────────────── */
/** Round face thumbnail, falling back to initials so a row is never blank. */
function Avatar({ url, name }: { url: string | null; name: string }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return url ? (
    /* A signed storage URL that expires; next/image would cache and optimise a
       private face photo, which is not what we want. */
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" className="w-8 h-8 rounded-full object-cover flex-none" />
  ) : (
    <span className="w-8 h-8 rounded-full flex-none bg-surface-elevated text-text-muted
                     grid place-items-center text-xs font-semibold">{initials}</span>
  );
}

/**
 * Everything about one guard, and the two things a supervisor actually does
 * from here: retire someone who has left, and re-enrol a face that will not
 * match. Both are supervisory acts and neither is available on a phone.
 */
function GuardDetail({ guard, onClose, onChanged }: {
  guard: GuardRow | null; onClose: () => void; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!guard) return null;

  async function patch(body: Record<string, unknown>) {
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/gate/guards", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ guardId: guard!.guardId, ...body }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.error ?? `HTTP ${r.status}`); return; }
      onChanged(); onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not reach the server.");
    } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={guard.name} subtitle={`${guard.city} gate`} size="md"
      footer={
        <div className="flex gap-2 items-center flex-wrap">
          <button className="btn btn-secondary" disabled={busy}
            onClick={() => patch({ status: guard.status === "active" ? "inactive" : "active" })}>
            {guard.status === "active" ? "Deactivate" : "Reactivate"}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
          {err && <span className="text-danger text-sm">{err}</span>}
        </div>
      }>
      <div className="flex gap-5 flex-wrap">
        {guard.referencePhotoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={guard.referencePhotoUrl} alt={guard.name}
               className="w-32 h-32 rounded-full object-cover border border-border flex-none" />
        ) : (
          <div className="w-32 h-32 rounded-full border border-border bg-surface-elevated
                          grid place-items-center text-text-muted flex-none">
            <Icon name="person" size={34} />
          </div>
        )}
        <dl className="flex-1 min-w-[220px] text-sm">
          <Row k="Employee code" v={guard.employeeCode ?? "—"} mono />
          <Row k="Phone" v={guard.phone ?? "—"} mono />
          <Row k="City" v={guard.city} />
          <Row k="Status" v={guard.status} />
          <Row k="Face enrolled" v={guard.hasReferencePhoto ? "Yes" : "No — cannot be verified at check-in"} />
          <Row k="Consent recorded" v={guard.consentAt ? new Date(guard.consentAt).toLocaleDateString() : "—"} />
        </dl>
      </div>
    </Modal>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-6 py-2 border-b border-border last:border-0">
      <dt className="text-text-muted">{k}</dt>
      <dd className={`text-text-primary text-right ${mono ? "font-mono" : ""}`}>{v}</dd>
    </div>
  );
}

function Devices({ user }: { user: SessionUser }) {
  const [pairing, setPairing] = useState<{ url: string; label: string } | null>(null);
  const [diag, setDiag] = useState<Record<string, unknown> | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [label, setLabel] = useState("Gate phone");
  // An ADMIN has no city — that is how the platform scopes them — so they must
  // say which gate the phone belongs to. A manager has exactly one and is not
  // asked. Getting this wrong is what made the button appear dead.
  const [city, setCity] = useState<string>(user.city ?? "");

  return (
    <div className="space-y-4">
      <p className="text-text-muted text-sm">
        A phone is enrolled once per gate. Any guard at that gate can then sign in on it.
      </p>

      <div className="card p-4 flex flex-wrap gap-3 items-end">
        {!user.city && (
          <label className="text-sm">Gate
            <select className="block mt-1 h-10 px-3 rounded-control border border-border bg-surface-card min-w-[160px]"
              value={city} onChange={(e) => setCity(e.target.value)}>
              <option value="">Choose a city…</option>
              {CITIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        )}
        <label className="text-sm">Label
          <input className="block mt-1 h-10 px-3 rounded-control border border-border bg-surface-card"
            value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Gate phone" />
        </label>
        <button className="btn btn-primary" disabled={busy || !city} onClick={async () => {
          setBusy(true); setErr(null);
          try {
            const r = await fetch("/api/gate/enrol", {
              method: "POST", headers: { "Content-Type": "application/json" },
              credentials: "same-origin",
              body: JSON.stringify({ city, deviceLabel: label }),
            });
            const j = await r.json().catch(() => ({}));
            // Say what went wrong. A button that silently does nothing is worse
            // than one that fails loudly — there is nothing to act on.
            if (!r.ok) { setErr(j.error ?? `Could not enrol the phone (HTTP ${r.status})`); return; }
            setPairing({ url: j.pairingUrl, label: j.deviceId });
            // Only worth showing where a bypass is actually needed. Production
            // has no protection to bypass, so the warning is just noise there.
            setDiag(
              j.protectionBypass || j.diagnostics?.vercelEnv !== "preview"
                ? null : (j.diagnostics ?? null)
            );
          } catch (e) {
            setErr(e instanceof Error ? e.message : "Could not reach the server.");
          } finally { setBusy(false); }
        }}>{busy ? "Enrolling…" : "Enrol a phone"}</button>
      </div>

      {err && <div className="card p-3 text-sm text-danger border border-danger/30">{err}</div>}


      {pairing && (
        <div className="card p-5 space-y-3">
          <h3 className="font-headline text-lg">Open this on the phone</h3>
          {/* Shown ONCE — the token is stored hashed and cannot be shown again.
              A lost phone is revoked and re-enrolled, never recovered. */}
          <p className="text-sm text-text-muted">
            This link appears only once. If you lose it, revoke the device and enrol again.
          </p>
          <code className="block p-3 bg-surface-elevated rounded-control text-xs break-all">{pairing.url}</code>
          {/* Only when the link came out WITHOUT a bypass on a protected
              preview — otherwise the phone silently cannot reach the app. */}
          {diag && (
            <div className="text-xs text-text-muted border border-border rounded-control p-3 space-y-1">
              <b className="text-text-secondary">No protection bypass on this link.</b>
              <div>Environment: <code>{String(diag.vercelEnv)}</code></div>
              <div>Bypass secret injected: <code>{String(diag.secretPresent)}</code></div>
              <div>System variables exposed: <code>{String(diag.systemVarsExposed)}</code></div>
            </div>
          )}
          <button className="btn btn-primary"
            onClick={() => {
              navigator.clipboard?.writeText(pairing.url);
              setCopied(true);
              setTimeout(() => setCopied(false), 2500);
            }}>{copied ? "Copied" : "Copy link"}</button>
        </div>
      )}

      <DeviceList city={user.city} refresh={pairing?.label ?? ""} />
    </div>
  );
}

/* ── Gates ──────────────────────────────────────────────────────────── */
interface Site {
  city: string; siteCode: string; label: string; address: string | null;
  serves: string | null; plusCode: string | null;
  lat: number | null; lng: number | null;
  radiusM: number; locatedAt: string | null; accuracyM: number | null; pinned: boolean;
}

/**
 * Where each warehouse gate is, pinned from the gate itself.
 *
 * Not geocoded from the address: searching "Dera Mandi" returns the centre of
 * the village, more than a kilometre from the building, and a geofence built on
 * that rejects every honest scan while looking perfectly reasonable. Somebody
 * standing at the gate pressing a button is the only source that is right.
 */
function Gates() {
  const [sites, setSites] = useState<Site[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/gate/sites", { credentials: "same-origin" })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        return j;
      })
      .then((j) => { setLoadErr(null); setSites(j.sites ?? []); })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function pin(city: string) {
    setBusy(city); setMsg(null);
    try {
      const pos = await new Promise<GeolocationPosition>((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej,
          { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 }));
      const r = await fetch("/api/gate/sites", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          city, lat: pos.coords.latitude, lng: pos.coords.longitude,
          accuracyM: pos.coords.accuracy,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg(j.error ?? `Could not save (HTTP ${r.status})`); return; }
      setMsg(`${city} pinned to within ${Math.round(pos.coords.accuracy)}m.`);
      load();
    } catch {
      setMsg("Could not read your location. Allow location access and try again.");
    } finally { setBusy(null); }
  }

  if (loadErr) return <LoadError what="the gates" detail={loadErr} onRetry={load} />;

  return (
    <div className="space-y-4">
      <p className="text-text-muted text-sm">
        Stand at the warehouse gate and press <b>Set from here</b>. Until a gate is
        pinned, its location check is skipped rather than failed.
      </p>
      {msg && <div className="card p-3 text-sm">{msg}</div>}
      <div className="space-y-3">
        {sites.map((s) => (
          <div key={s.city} className="card p-4 flex gap-4 flex-wrap items-start">
            <div className="flex-1 min-w-[240px]">
              <div className="flex items-center gap-2">
                <b className="text-text-primary">{s.label}</b>
                <span className={`badge ${s.pinned ? "badge-done" : "badge-medium"}`}>
                  {s.pinned ? "pinned" : "not set"}
                </span>
              </div>
              {s.serves && <div className="text-xs text-text-muted mt-0.5">Serves {s.serves}</div>}
              {s.address && <div className="text-sm text-text-secondary mt-1.5">{s.address}</div>}
              <div className="text-xs text-text-muted mt-1.5 font-mono">
                {s.pinned
                  ? `${s.lat!.toFixed(5)}, ${s.lng!.toFixed(5)} · ${s.radiusM}m radius` +
                    (s.locatedAt ? " · pinned on site" : s.plusCode ? ` · from ${s.plusCode}` : "")
                  : "no coordinates yet — location check skipped"}
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              {s.pinned && (
                <a className="btn btn-compact btn-secondary" target="_blank" rel="noreferrer"
                   href={`https://www.google.com/maps?q=${s.lat},${s.lng}`}>Check on map</a>
              )}
              <button className="btn btn-compact btn-primary" disabled={busy === s.city}
                onClick={() => pin(s.city)}>
                {busy === s.city ? "Reading…" : s.pinned ? "Re-set from here" : "Set from here"}
              </button>
            </div>
          </div>
        ))}
      </div>

    </div>
  );
}

interface DeviceRow {
  id: string; deviceId: string; city: string; label: string | null;
  status: string; lastSeenAt: string | null; createdAt: string;
  signIns: { guardName: string; ok: boolean; reason: string | null; at: string }[];
}

/**
 * The enrolled phones and who has signed in on each.
 *
 * Refusals are shown beside successes on purpose. One wrong PIN is somebody
 * fumbling; five on one handset is the only visible sign that a phone is being
 * tried by someone it does not belong to.
 */
function DeviceList({ city, refresh }: { city: string | null; refresh: string }) {
  const [rows, setRows] = useState<DeviceRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(() => {
    const q = city ? `?city=${encodeURIComponent(city)}` : "";
    fetch(`/api/gate/devices${q}`, { credentials: "same-origin" })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        return j;
      })
      .then((j) => { setErr(null); setRows(j.devices ?? []); })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [city]);
  useEffect(() => { load(); }, [load, refresh]);

  if (err) return <LoadError what="the enrolled phones" detail={err} onRetry={load} />;
  if (rows.length === 0) return <Empty text="No phones enrolled yet." />;

  return (
    <div className="space-y-3">
      <h3 className="font-headline text-base text-text-primary">Enrolled phones</h3>
      {rows.map((dv) => {
        const failed = dv.signIns.filter((s) => !s.ok).length;
        return (
          <div key={dv.id} className="card p-4">
            <button className="w-full flex items-center gap-3 text-left"
                    onClick={() => setOpenId(openId === dv.id ? null : dv.id)}>
              <Icon name="shield" size={18} className="text-text-muted" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-text-primary">
                  {dv.label || "Gate phone"} <span className="text-text-muted font-normal">· {dv.city}</span>
                </div>
                <div className="text-xs text-text-muted">
                  {dv.lastSeenAt ? `Last used ${time(dv.lastSeenAt)}` : "Never used"}
                  {" · "}{dv.signIns.length} sign-in{dv.signIns.length === 1 ? "" : "s"}
                </div>
              </div>
              {failed > 0 && <span className="badge badge-high">{failed} refused</span>}
              <span className={`badge ${dv.status === "active" ? "badge-done" : "badge-suppressed"}`}>{dv.status}</span>
              <Icon name={openId === dv.id ? "expand_less" : "expand_more"} size={17} className="text-text-muted" />
            </button>

            {openId === dv.id && (
              dv.signIns.length === 0
                ? <p className="text-sm text-text-muted mt-3">Nobody has signed in on this phone yet.</p>
                : <div className="mt-3 border-t border-border pt-2">
                    {dv.signIns.map((si, i) => (
                      <div key={i} className="flex items-center gap-3 py-1.5 text-sm">
                        <Icon name={si.ok ? "check_circle" : "warning"} size={15}
                              className={si.ok ? "text-success" : "text-danger"} />
                        <span className="flex-1">{si.guardName}</span>
                        {!si.ok && <span className="text-danger text-xs">{(si.reason ?? "refused").replace(/_/g, " ")}</span>}
                        <span className="text-text-muted text-xs whitespace-nowrap">{time(si.at)}</span>
                      </div>
                    ))}
                  </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ── Reviews ────────────────────────────────────────────────────────── */
interface Check {
  id: string; guardId: string; guardName: string; city: string; trigger: string; capturedAt: string;
  matchScore: number | null; verdict: string; reviewState: string;
  geoOk: boolean | null; selfieUrl: string | null;
}

/**
 * Every photo check, not only the ones needing a decision.
 *
 * It listed pending checks alone, so a random in-shift check that PASSED was
 * recorded and then invisible — you could see that someone had failed a check
 * but never that the checks were happening at all, which is most of what you
 * want from a spot check.
 */
function Reviews() {
  const [rows, setRows] = useState<Check[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [state, setState] = useState<"pending" | "all">("pending");
  const [trigger, setTrigger] = useState("");
  const [date, setDate] = useState("");

  const load = useCallback(() => {
    const q = new URLSearchParams({ state });
    if (trigger) q.set("trigger", trigger);
    if (date) q.set("date", date);
    fetch(`/api/gate/reviews?${q}`, { credentials: "same-origin" })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        return j;
      })
      .then((j) => { setLoadErr(null); setRows(j.checks ?? []); })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [state, trigger, date]);
  useEffect(() => { load(); }, [load]);

  async function decide(id: string, decision: "accepted" | "rejected") {
    await fetch("/api/gate/reviews", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      credentials: "same-origin", body: JSON.stringify({ id, decision }),
    });
    load();
  }

  return (
    <div className="space-y-4">
      <div className="card p-3 flex flex-wrap gap-2 items-center">
        <div className="bg-surface-elevated rounded-control p-1 flex">
          {([["pending", "Needs a look"], ["all", "Everything"]] as const).map(([v, label]) => (
            <button key={v} onClick={() => setState(v)}
              className={state === v
                ? "px-3 py-1 text-sm font-medium rounded-control bg-surface-card shadow-card"
                : "px-3 py-1 text-sm text-text-secondary rounded-control"}>{label}</button>
          ))}
        </div>
        <select value={trigger} onChange={(e) => setTrigger(e.target.value)}
          className="h-9 px-2 rounded-control border border-border bg-surface-card text-sm">
          <option value="">Check-in, check-out and spot checks</option>
          <option value="check_in">Check-in only</option>
          <option value="check_out">Check-out only</option>
          <option value="random">Spot checks only</option>
        </select>
        <input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)}
          className="h-9 px-2 rounded-control border border-border bg-surface-card text-sm" />
        {(trigger || date) && (
          <button className="btn btn-compact btn-secondary"
            onClick={() => { setTrigger(""); setDate(""); }}>Clear</button>
        )}
        <span className="ml-auto text-xs text-text-muted">{rows.length} shown</span>
      </div>

      {loadErr && <LoadError what="the photo checks" detail={loadErr} onRetry={load} />}
      {loading && <p className="text-text-muted text-sm">Loading…</p>}

      {!loading && !loadErr && rows.length === 0 && (
        <Empty text={state === "pending"
          ? "Nothing waiting. Every check matched."
          : "No photo checks for these filters."} />
      )}

      {!loadErr && rows.length > 0 && (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {rows.map((c) => (
            <div key={c.id} className="card p-4 space-y-3">
              {c.selfieUrl
                /* eslint-disable-next-line @next/next/no-img-element -- a signed
                   URL that expires; next/image would cache a face photo. */
                ? <img src={c.selfieUrl} alt={`Photo check for ${c.guardName}`}
                       className="w-full h-44 object-cover rounded-control" />
                : <div className="w-full h-44 rounded-control bg-surface-elevated grid place-items-center text-text-muted text-sm">
                    Photo expired or not taken
                  </div>}
              <div>
                <div className="flex items-center gap-2">
                  <b className="text-text-primary">{c.guardName}</b>
                  <span className={`badge ${c.trigger === "random" ? "badge-info" : "badge-done"}`}>
                    {c.trigger === "random" ? "spot check"
                      : c.trigger === "check_in" ? "check-in" : "check-out"}
                  </span>
                </div>
                <div className="text-xs text-text-muted mt-1">{c.city} · {time(c.capturedAt)}</div>
                <div className="text-xs text-text-muted mt-1">
                  {/* The raw distance, shown rather than hidden: the thresholds
                      are a starting point and this is what re-tunes them. */}
                  {c.matchScore === null ? "no score" : `score ${c.matchScore}`}
                  {c.verdict === "skipped" && " · not answered"}
                  {c.geoOk === false && " · outside the gate"}
                  {c.geoOk === null && " · no location"}
                </div>
              </div>
              {c.reviewState === "pending" ? (
                <div className="flex gap-2">
                  <button className="btn btn-compact btn-primary flex-1" onClick={() => decide(c.id, "accepted")}>
                    It&rsquo;s them
                  </button>
                  <button className="btn btn-compact btn-secondary flex-1" onClick={() => decide(c.id, "rejected")}>
                    Not them
                  </button>
                </div>
              ) : (
                <span className={`badge ${c.reviewState === "rejected" ? "badge-high"
                  : c.reviewState === "accepted" ? "badge-done" : "badge-suppressed"}`}>
                  {c.reviewState === "none" ? "matched" : c.reviewState}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── shared ─────────────────────────────────────────────────────────── */
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const took = (secs: number | null) =>
  secs === null ? "—" : secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;

const time = (iso: string) =>
  new Date(iso).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: "ok" | "warn" }) {
  return (
    <div className="card p-4">
      <div className={`text-2xl font-semibold tabular-nums ${tone === "warn" ? "text-warning" : "text-text-primary"}`}>{value}</div>
      <div className="text-xs text-text-muted mt-1">{label}</div>
    </div>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="space-y-2"><h2 className="font-headline text-base text-text-primary">{title}</h2>{children}</div>;
}
function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr>{head.map((h) => <th key={h} className="text-left px-4 py-2 text-xs uppercase tracking-wide text-text-muted">{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
/**
 * A read that FAILED, shown as a failure.
 *
 * This component exists because of a real incident: a guard was saved
 * correctly, the list query was rejected by PostgREST, and the screen said
 * "No guards yet." The record was there the whole time. An empty state is a
 * statement about the data; an error is a statement about the request, and
 * conflating them sends someone hunting for a bug that is not there.
 */
function LoadError({ what, detail, onRetry }: { what: string; detail: string; onRetry: () => void }) {
  return (
    <div className="card p-5 border border-danger/30 space-y-2">
      <div className="flex items-center gap-2 text-danger font-medium">
        <Icon name="warning" size={17} />Could not load {what}
      </div>
      <p className="text-sm text-text-muted">
        This is a failure to read, not an empty list — anything saved is still there.
      </p>
      <code className="block text-xs bg-surface-elevated p-2 rounded-control break-all">{detail}</code>
      <button className="btn btn-compact btn-secondary" onClick={onRetry}>Try again</button>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="card p-8 text-center text-text-muted text-sm">{text}</div>;
}
