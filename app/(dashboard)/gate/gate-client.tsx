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
import { CITIES } from "@/lib/sample-data";
import type { SessionUser } from "@/lib/demo-auth";

type Tab = "activity" | "guards" | "devices" | "reviews";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "activity", label: "Activity", icon: "dashboard" },
  { id: "guards", label: "Guards", icon: "group" },
  { id: "devices", label: "Devices", icon: "upload_file" },
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

      {tab === "activity" && <Activity />}
      {tab === "guards" && <Guards user={user} />}
      {tab === "devices" && <Devices user={user} />}
      {tab === "reviews" && <Reviews />}
    </section>
  );
}

/* ── Activity ───────────────────────────────────────────────────────── */
interface ActivityData {
  businessDate: string;
  totals: { items: number; trips: number; scanned: number; manual: number;
            overrides: number; awaitingBarcode: number; scannedShare: number | null };
  trips: { id: string; direction: string; vehicleNo: string; openedAt: string;
           closedAt: string | null; status: string; guardName: string; items: number }[];
  scans: { id: string; direction: string; barcode: string | null; itemKind: string;
           quantity: number; entryMethod: string; override: boolean;
           awaitingBarcode: boolean; scannedAt: string; guardName: string }[];
}

function Activity() {
  const [d, setD] = useState<ActivityData | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    fetch("/api/gate/activity", { credentials: "same-origin" })
      .then((r) => r.json()).then(setD).finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-text-muted text-sm">Loading…</p>;
  if (!d?.totals) return <Empty text="Nothing recorded at the gate yet." />;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Items" value={d.totals.items} />
        <Stat label="Trips" value={d.totals.trips} />
        {/* The number the pilot is judged on: how much is scanned rather than
            typed. A falling share means guards are working around the scanner. */}
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

      <Section title={`Trips · ${d.businessDate}`}>
        {d.trips.length === 0 ? <Empty text="No trips yet today." /> : (
          <Table head={["Vehicle", "Direction", "Guard", "Items", "Status"]}>
            {d.trips.map((t) => (
              <tr key={t.id}>
                <td className="font-mono">{t.vehicleNo}</td>
                <td>{t.direction}</td><td>{t.guardName}</td>
                <td className="text-right tabular-nums">{t.items}</td>
                <td><span className={`badge ${t.status === "closed" ? "badge-done" : "badge-info"}`}>{t.status}</span></td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title="Items">
        {d.scans.length === 0 ? <Empty text="Nothing scanned yet today." /> : (
          <Table head={["Barcode", "Kind", "Qty", "How", "Guard", "Time"]}>
            {d.scans.map((s) => (
              <tr key={s.id}>
                {/* The RAW scanned spelling — never the fold. That is the whole
                    point of the scanning project. */}
                <td className="font-mono">{s.barcode ?? "—"}</td>
                <td>{s.itemKind.replace(/_/g, " ")}</td>
                <td className="text-right tabular-nums">{s.quantity}</td>
                <td>
                  <span className={`badge ${s.entryMethod === "scan" ? "badge-done" : "badge-medium"}`}>
                    {s.entryMethod}
                  </span>
                  {s.override && <span className="badge badge-high ml-1">override</span>}
                </td>
                <td>{s.guardName}</td>
                <td className="text-text-secondary whitespace-nowrap">{time(s.scannedAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </div>
  );
}

/* ── Guards ─────────────────────────────────────────────────────────── */
interface GuardRow {
  guardId: string; name: string; city: string; employeeCode: string | null;
  phone: string | null; status: string; hasReferencePhoto: boolean;
  referencePhotoUrl: string | null;
}

function Guards({ user }: { user: SessionUser }) {
  const [rows, setRows] = useState<GuardRow[]>([]);
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/gate/guards", { credentials: "same-origin" })
      .then((r) => r.json()).then((j) => setRows(j.guards ?? []));
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
      {rows.length === 0 ? <Empty text="No guards yet." /> : (
        <Table head={["Name", "Code", "City", "Face enrolled", "Status"]}>
          {rows.map((g) => (
            <tr key={g.guardId}>
              <td className="font-medium">{g.name}</td>
              <td className="font-mono">{g.employeeCode ?? "—"}</td>
              <td>{g.city}</td>
              <td>
                {/* A guard with no face signature cannot be verified at all, so
                    it is stated rather than left blank. */}
                <span className={`badge ${g.hasReferencePhoto ? "badge-done" : "badge-medium"}`}>
                  {g.hasReferencePhoto ? "yes" : "not yet"}
                </span>
              </td>
              <td><span className={`badge ${g.status === "active" ? "badge-done" : "badge-suppressed"}`}>{g.status}</span></td>
            </tr>
          ))}
        </Table>
      )}
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
  const [shot, setShot] = useState<{ blob: Blob; descriptor: number[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Say which of the three states we are in. A blank circle tells the operator
  // nothing — they cannot know whether to wait, grant permission, or give up.
  const [cam, setCam] = useState<"starting" | "live" | "blocked">("starting");

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
      setShot({ blob: file, descriptor: toArray(d) });
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
      setShot({ blob, descriptor: toArray(d) });
    } finally { setBusy(false); }
  }

  async function save() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/gate/guards", {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name, city, pin, employeeCode: code || undefined,
                               descriptor: shot?.descriptor }),
      });
      const j = await res.json().catch(() => ({}));
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
          {shot && (
            <span className="absolute inset-0 grid place-items-center bg-success/85 text-white">
              <Icon name="check" size={40} />
            </span>
          )}
        </div>

        {/* Two ways in, nothing else. Upload is not a fallback for a broken
            camera so much as the equal option — a manager enrolling five guards
            from existing photos should not have to line each one up. */}
        <div className="flex flex-col gap-2">
          <button className="btn btn-secondary" onClick={capture} disabled={busy || cam !== "live"}>
            <Icon name="camera" size={17} />{shot ? "Retake photo" : "Take photo"}
          </button>
          <label className={`btn btn-secondary ${busy ? "opacity-60" : "cursor-pointer"}`}>
            <Icon name="cloud_upload" size={17} />Upload photo
            <input type="file" accept="image/*" className="hidden" disabled={busy}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void readPhotoFile(f); }} />
          </label>
        </div>
      </div>

      <div className="flex gap-2">
        <button className="btn btn-primary"
          disabled={busy || !name || !city || !/^\d{4,6}$/.test(pin) || !shot}
          onClick={save}>Save guard</button>
        <button className="btn btn-secondary" onClick={() => onDone("")}>Cancel</button>
      </div>
    </div>
  );
}

/* ── Devices ────────────────────────────────────────────────────────── */
function Devices({ user }: { user: SessionUser }) {
  const [pairing, setPairing] = useState<{ url: string; label: string } | null>(null);
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
          <button className="btn btn-secondary"
            onClick={() => navigator.clipboard?.writeText(pairing.url)}>Copy link</button>
        </div>
      )}
    </div>
  );
}

/* ── Reviews ────────────────────────────────────────────────────────── */
interface Check {
  id: string; guardName: string; city: string; trigger: string; capturedAt: string;
  matchScore: number | null; verdict: string; reviewState: string;
  geoOk: boolean | null; selfieUrl: string | null;
}

function Reviews() {
  const [rows, setRows] = useState<Check[]>([]);
  const [loading, setLoading] = useState(true);

  // No synchronous setState here: `loading` already starts true, and on a
  // reload after a decision a briefly stale card is better than a flash of
  // spinner over the queue someone is working through.
  const load = useCallback(() => {
    fetch("/api/gate/reviews", { credentials: "same-origin" })
      .then((r) => r.json()).then((j) => setRows(j.checks ?? [])).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function decide(id: string, decision: "accepted" | "rejected") {
    await fetch("/api/gate/reviews", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      credentials: "same-origin", body: JSON.stringify({ id, decision }),
    });
    load();
  }

  if (loading) return <p className="text-text-muted text-sm">Loading…</p>;
  if (rows.length === 0) return <Empty text="Nothing waiting. Every check-in matched." />;

  return (
    <div className="space-y-3">
      <p className="text-text-muted text-sm">
        Photos the phone could not match confidently. A guard is never blocked by this —
        the shift already happened.
      </p>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {rows.map((c) => (
          <div key={c.id} className="card p-4 space-y-3">
            {c.selfieUrl
              /* eslint-disable-next-line @next/next/no-img-element -- a signed
                 storage URL that expires in 30 minutes; next/image would cache
                 and optimise a private face photo, which is not what we want. */
              ? <img src={c.selfieUrl} alt={`Check-in photo for ${c.guardName}`}
                     className="w-full h-44 object-cover rounded-control" />
              : <div className="w-full h-44 rounded-control bg-surface-elevated grid place-items-center text-text-muted text-sm">
                  No photo
                </div>}
            <div>
              <b className="text-text-primary">{c.guardName}</b>
              <div className="text-xs text-text-muted">
                {c.city} · {c.trigger.replace(/_/g, " ")} · {time(c.capturedAt)}
              </div>
              <div className="text-xs text-text-muted mt-1">
                {/* The raw distance, shown rather than hidden: the thresholds are
                    a starting point and this is what re-tunes them. */}
                {c.matchScore === null ? "no score" : `score ${c.matchScore}`}
                {c.geoOk === false && " · outside the gate"}
                {c.geoOk === null && " · no location"}
              </div>
            </div>
            <div className="flex gap-2">
              <button className="btn btn-compact btn-primary flex-1" onClick={() => decide(c.id, "accepted")}>
                It&rsquo;s them
              </button>
              <button className="btn btn-compact btn-secondary flex-1" onClick={() => decide(c.id, "rejected")}>
                Not them
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── shared ─────────────────────────────────────────────────────────── */
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
function Empty({ text }: { text: string }) {
  return <div className="card p-8 text-center text-text-muted text-sm">{text}</div>;
}
