"use client";

// The Gate section — one destination with four tabs, rather than five sidebar
// entries. The sidebar was already at ten items; adding the gate work as
// separate rows would have pushed it to fifteen, which is past the point anyone
// scans a list instead of hunting it.
//
// The paper register lives in here too, as one of the tabs, and only shows for
// cities not yet on the app. That makes the pilot legible: a manager can see at
// a glance which cities scan and which still upload a PDF.

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { ErrorState } from "@/components/error-state";
import { Icon } from "@/components/icon";
import { Modal } from "@/components/modal";
import { CITIES } from "@/lib/sample-data";
import { groupVisits } from "@/lib/gate/transport";
import type { SessionUser } from "@/lib/demo-auth";

type Tab = "activity" | "guards" | "devices" | "gates" | "reviews" | "attendance";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "activity", label: "Activity", icon: "dashboard" },
  { id: "attendance", label: "Attendance", icon: "schedule" },
  { id: "guards", label: "Guards", icon: "group" },
  { id: "devices", label: "Devices", icon: "upload_file" },
  { id: "gates", label: "Gates", icon: "location_on" },
  { id: "reviews", label: "Reviews", icon: "pending_actions" },
];

export default function GateClient({ user }: { user: SessionUser }) {
  const [tab, setTab] = useState<Tab>("activity");
  // How many face checks are waiting on somebody.
  //
  // WHY IT IS ON THE TAB. Seventeen were sitting unlooked-at, and the queue was
  // working exactly as built — the page simply never said so. A review queue
  // nobody opens is the same as no review at all, which is precisely the
  // criticism the face check earned in the first place: a control that only
  // records is not a control.
  const [pending, setPending] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => fetch("/api/gate/reviews?state=pending&countOnly=1")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive && j) setPending(j.count ?? 0); })
      .catch(() => {});
    void load();
    // Re-read when the reviews tab is left, so acting on one updates the badge.
    return () => { alive = false; };
  }, [tab]);
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
            {x.id === "reviews" && pending !== null && pending > 0 && (
              <span className="badge badge-high ml-1">{pending}</span>
            )}
          </button>
        ))}
      </div>

      {tab === "activity" && <Activity user={user} />}
      {tab === "guards" && <Guards user={user} />}
      {tab === "devices" && <Devices user={user} />}
      {tab === "gates" && <Gates />}
      {tab === "reviews" && <Reviews />}
      {tab === "attendance" && <Attendance user={user} />}
    </section>
  );
}

/* ── Activity ───────────────────────────────────────────────────────── */
interface TripItem {
  id: string; barcode: string | null; serialNo: string | null; product: string | null;
  soNumber: string | null; itemKind: string; quantity: number; entryMethod: string;
  override: string | null; exception: string | null; awaitingBarcode: boolean;
  geoOk: boolean | null; hasPhoto: boolean; scannedAt: string;
  /** The register row. Witnessed where the guard recorded it, otherwise looked
   *  up by barcode from Odoo and DT after the scan — see migration 0039. */
  itemName: string | null; soDisplay: string | null; ticket: string | null;
  customer: string | null; jobType: string | null;
  /** True when no DT task sits near the scan date and the unit's latest one is
   *  shown instead — labelled on screen and in the file, never passed off as
   *  this movement's. */
  lastKnown: boolean; taskDate: string | null;
  notes: string | null;
  /** Repeats an earlier entry — shown, never counted. */
  duplicateOf: { of: string; ofScannedAt: string; reason: string } | null;
  /** A lookup is still owed; a dash here would read as "nothing to find". */
  lookupPending: boolean;
}
/** What the completeness check found when the trip closed. Null when the trip
 *  predates the check, or closed with no list to check against — which is a
 *  different thing from "nothing was missing" and must stay distinguishable. */
interface TripCompleteness {
  total: number; scanned: number; missing: string[];
  unplanned: number;
  /** Was the guard actually shown this? False through the silent period. */
  warned: boolean;
}
/** A scan the guard took back. Never counted as movement; always visible. */
interface RemovedItem { barcode: string | null; reason: string | null; at: string }

interface Trip {
  id: string; direction: string; vehicleNo: string; driverName: string | null;
  carrierRef: string | null; city: string; siteCode: string;
  openedAt: string; closedAt: string | null; status: string; durationSec: number | null;
  guardName: string; itemCount: number; overrides: number; manual: number; items: TripItem[];
  duplicates: number;
  removed: RemovedItem[];
  completeness: TripCompleteness | null;
}
interface ActivityData {
  businessDate: string;
  totals: { trips: number; items: number; scanned: number; manual: number;
            overrides: number; awaitingBarcode: number; scannedShare: number | null;
            removed: number; tripsShort: number; tripsChecked: number; duplicates: number };
  guards: { id: string; name: string }[];
  /** One entry per truck / agent however it was spelled; `key` is what filters. */
  vehicles: { key: string; label: string; trips: number }[];
  agents: { key: string; label: string; trips: number }[];
  trips: Trip[];
}

/**
 * The business day currently OPEN — not the calendar date.
 *
 * THE BUG THIS FIXES. The gate's day runs 15:00 → 15:00 IST, so work done on
 * the morning of the 25th is filed under the 24th. This defaulted to the UTC
 * calendar date, which means that from 05:30 to 15:00 IST every day — the
 * entire morning shift — the page opened on a date the gate had not started
 * writing to yet, and showed an empty day while guards were scanning.
 */
const today = () => {
  const IST = 5.5 * 3600_000;
  const ist = new Date(Date.now() + IST);
  // Before 15:00 IST the open business day is still yesterday's date.
  if (ist.getUTCHours() < 15) ist.setUTCDate(ist.getUTCDate() - 1);
  return ist.toISOString().slice(0, 10);
};

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
  const [vehicle, setVehicle] = useState("");
  const [agent, setAgent] = useState("");
  // Grouping is a way of LOOKING at the day, not a filter: every trip is still
  // there, gathered under its truck. The gap is the manager's call — a yard
  // that reloads a truck for forgotten items within the hour reads differently
  // from one where the evening return is a separate event.
  const [grouped, setGrouped] = useState(false);
  const [gapHours, setGapHours] = useState(2);
  const [openVisits, setOpenVisits] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    const q = new URLSearchParams({ date });
    if (city) q.set("city", city);
    if (guardId) q.set("guardId", guardId);
    if (direction) q.set("direction", direction);
    if (vehicle) q.set("vehicle", vehicle);
    if (agent) q.set("agent", agent);
    fetch(`/api/gate/activity?${q}`, { credentials: "same-origin" })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        return j;
      })
      .then((j) => { setLoadErr(null); setD(j); })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [date, city, guardId, direction, vehicle, agent]);
  useEffect(() => { load(); }, [load]);

  /** One trip as a table row — on its own, or indented under its visit. */
  const tripRow = (tr: Trip, nested = false) => (
                    <tr key={tr.id} onClick={() => setOpen(tr)}
                        className={`border-t border-border hover:bg-surface-elevated cursor-pointer transition-colors duration-150${nested ? " text-[13px]" : ""}`}>
                      <td className={`py-2.5 font-medium text-text-primary whitespace-nowrap ${nested ? "pl-9 pr-4" : "px-4"}`}>{tr.guardName || "—"}</td>
                      <td className="px-4 py-2.5 font-mono whitespace-nowrap">{tr.vehicleNo}</td>
                      <td className="px-4 py-2.5">
                        <span className={`badge ${tr.direction === "OUT" ? "badge-medium" : "badge-info"}`}>
                          {tr.direction === "OUT" ? "Outward" : "Inward"}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 tabular-nums">
                        {tr.itemCount}
                        {tr.overrides > 0 && <span className="badge badge-high ml-2">{tr.overrides} override</span>}
                        {/* Two different problems, and a manager scanning this
                            column needs to tell them apart at a glance: the
                            truck left short, versus the guard took items back. */}
                        {tr.completeness && tr.completeness.missing.length > 0 && (
                          <span className="badge badge-high ml-2">
                            {tr.completeness.missing.length} short
                          </span>
                        )}
                        {tr.removed.length > 0 && (
                          <span className="badge badge-medium ml-2">{tr.removed.length} removed</span>
                        )}
                        {/* Entered again for an item already recorded. Not in the
                            count to the left, and not in the reconciliation. */}
                        {tr.duplicates > 0 && (
                          <span className="badge badge-high ml-2">{tr.duplicates} duplicate</span>
                        )}
                        {/* Typed rather than scanned. No barcode was read, so
                            the row rests entirely on the guard and the photo
                            they took — which is precisely what a manager is
                            here to look at. */}
                        {tr.manual > 0 && (
                          <span className="badge badge-medium ml-2">{tr.manual} typed</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-text-secondary whitespace-nowrap">{clock(tr.openedAt)}</td>
                      <td className="px-4 py-2.5 text-text-secondary whitespace-nowrap tabular-nums">{took(tr.durationSec)}</td>
                      <td className="px-4 py-2.5">
                        <span className={`badge ${tr.status === "closed" ? "badge-done" : "badge-info"}`}>{tr.status}</span>
                      </td>
                      <td className="px-2 text-text-muted"><Icon name="chevron_right" size={17} /></td>
                    </tr>
  );

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
        <select value={vehicle} onChange={(e) => setVehicle(e.target.value)} aria-label="Transport"
          className="h-9 px-2 rounded-control border border-border bg-surface-card text-sm">
          <option value="">All transport</option>
          {(d?.vehicles ?? []).map((v) => <option key={v.key} value={v.key}>{v.label} ({v.trips})</option>)}
        </select>
        <select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent"
          className="h-9 px-2 rounded-control border border-border bg-surface-card text-sm">
          <option value="">All agents</option>
          {(d?.agents ?? []).map((a) => <option key={a.key} value={a.key}>{a.label} ({a.trips})</option>)}
        </select>
        {(guardId || direction || vehicle || agent || (!user.city && city)) && (
          <button className="btn btn-compact btn-secondary"
            onClick={() => { setGuardId(""); setDirection(""); setVehicle(""); setAgent(""); setCity(user.city ?? ""); }}>
            Clear
          </button>
        )}
        <label className="flex items-center gap-2 text-sm ml-2 cursor-pointer select-none">
          <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} />
          Group by transport
        </label>
        {grouped && (
          <select value={gapHours} onChange={(e) => setGapHours(Number(e.target.value))} aria-label="New visit after a gap of"
            className="h-9 px-2 rounded-control border border-border bg-surface-card text-sm"
            title="Trips on the same truck further apart than this are shown as separate visits">
            {[0.5, 1, 2, 4, 8].map((h) => (
              <option key={h} value={h}>new visit after {h < 1 ? "30 min" : `${h} h`} gap</option>
            ))}
          </select>
        )}
        <span className="ml-auto text-xs text-text-muted">{d?.businessDate ?? date}</span>
      </div>

      {loadErr && <ErrorState what="gate activity" detail={loadErr} onRetry={load} />}
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

          {/* THIS IS THE ONLY PLACE THE MATCH APPEARS. The guard is never shown
              what was expected — see tests/gate/independence.test.ts for why —
              so the check runs in the background and surfaces here, after the
              fact, for somebody who is not the person being checked.

              Shown as a share of trips CHECKED rather than of all trips: a trip
              that closed with no list to check against was not a false alarm,
              it was not an alarm. */}
          {d.totals.tripsChecked > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Checked against plan" value={`${d.totals.tripsChecked}/${d.totals.trips}`} />
              <Stat label="Left short" value={d.totals.tripsShort}
                    tone={d.totals.tripsShort > 0 ? "warn" : "ok"} />
              <Stat label="Items removed" value={d.totals.removed}
                    tone={d.totals.removed > 0 ? "warn" : "ok"} />
              <Stat label="Typed, not scanned" value={d.totals.manual}
                    tone={d.totals.manual > 0 ? "warn" : "ok"} />
            </div>
          )}

          {d.totals.duplicates > 0 && (
            <div className="card p-4 border border-warning/30 text-sm">
              <b>{d.totals.duplicates}</b> duplicate entr{d.totals.duplicates === 1 ? "y" : "ies"} —
              the same item recorded again. Shown on their trips, left out of every count.
            </div>
          )}

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
                    {["Guard", "Vehicle", "Direction", "Items", "Opened", "Time at gate", "Status"].map((h) => (
                      <th key={h} className="text-left px-4 py-2.5 text-xs uppercase tracking-wide text-text-muted whitespace-nowrap">{h}</th>
                    ))}
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {!grouped && d.trips.map((tr) => tripRow(tr))}
                  {grouped && groupVisits(d.trips.map((x) => ({ ...x,
                    lastActivityAt: x.items.reduce<string | null>((m, i) => (!m || i.scannedAt > m ? i.scannedAt : m), null),
                  })), gapHours * 3600_000).map((v) => {
                    const id = `${v.key}|${v.start}`;
                    const isOpen = openVisits.has(id);
                    const items = v.trips.reduce((n, x) => n + x.itemCount, 0);
                    const agentsOn = [...new Set(v.trips.map((x) => x.driverName).filter(Boolean))];
                    const spellings = [...new Set(v.trips.map((x) => x.vehicleNo))];
                    const dirs = [...new Set(v.trips.map((x) => (x.direction === "OUT" ? "Outward" : "Inward")))];
                    return (
                      <Fragment key={id}>
                        <tr onClick={() => setOpenVisits((s0) => {
                              const n = new Set(s0); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
                            className="border-t border-border bg-surface-elevated/60 hover:bg-surface-elevated cursor-pointer">
                          <td className="px-4 py-2.5 text-text-secondary whitespace-nowrap">
                            {[...new Set(v.trips.map((x) => x.guardName).filter(Boolean))].join(", ") || "—"}
                          </td>
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <span className="font-mono font-semibold text-text-primary">{v.key}</span>
                            {/* The spellings actually recorded, so a manager can see
                                the grouping was not a guess. */}
                            {spellings.length > 1 && (
                              <span className="block text-xs text-text-muted" title={spellings.join(" · ")}>
                                {spellings.length} spellings
                              </span>
                            )}
                            {agentsOn.length > 0 && (
                              <span className="block text-xs text-text-muted">{agentsOn.join(", ")}</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-text-secondary whitespace-nowrap">{dirs.join(" + ")}</td>
                          <td className="px-4 py-2.5 tabular-nums">
                            {items}
                            <span className="text-xs text-text-muted ml-2">
                              in {v.trips.length} trip{v.trips.length === 1 ? "" : "s"}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-text-secondary whitespace-nowrap">
                            {clock(v.start)} – {clock(v.end)}
                          </td>
                          <td className="px-4 py-2.5" />
                          <td className="px-4 py-2.5" />
                          <td className="px-2 text-text-muted">
                            <Icon name={isOpen ? "expand_less" : "expand_more"} size={17} />
                          </td>
                        </tr>
                        {isOpen && v.trips.map((tr) => tripRow(tr, true))}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <TripModal trip={open ? (d?.trips.find((t) => t.id === open.id) ?? open) : null}
                 onClose={() => setOpen(null)} onLookedUp={load} />
    </div>
  );
}

/** Everything about one trip, including the items the table only counts. */
export function TripModal({ trip, onClose, onLookedUp }: {
  trip: Trip | null; onClose: () => void; onLookedUp: () => void;
}) {
  const [photo, setPhoto] = useState<{ scanId: string; label: string } | null>(null);
  const [lookup, setLookup] = useState<"idle" | "running" | "failed">("idle");
  const asked = useRef<string | null>(null);

  // Ask for this trip's details the moment it is opened, once per trip. The
  // scheduled lookup runs every two hours, and a manager opens a trip right
  // after the truck leaves — which is exactly when it would still be bare.
  const tripId = trip?.id ?? null;
  const pending = !!trip?.items.some((i) => i.lookupPending);
  useEffect(() => {
    if (!tripId || !pending || asked.current === tripId) return;
    asked.current = tripId;
    setLookup("running");
    fetch("/api/gate/activity/enrich", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tripId }),
    })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.ok === false) throw new Error(j.error ?? "lookup failed");
        setLookup("idle"); onLookedUp();
      })
      .catch(() => setLookup("failed"));
  }, [tripId, pending, onLookedUp]);

  if (!trip) return null;
  return (
    <Modal open onClose={onClose}
      title={`${trip.vehicleNo} · ${trip.direction === "OUT" ? "Outward" : "Inward"}`}
      subtitle={`${trip.guardName} · ${trip.city}`} size="wide">
      <div className="grid sm:grid-cols-2 gap-x-8 mb-5">
        <Row k="Guard" v={trip.guardName || "—"} />
        <Row k="Delivery agent" v={trip.driverName ?? "—"} />
        <Row k="Opened" v={clock(trip.openedAt)} mono />
        <Row k="Closed" v={trip.closedAt ? clock(trip.closedAt) : "still open"} mono />
        {/* "Took" was a one-word column nobody could interpret. It is the
            gap between the guard starting the trip and closing it — how long
            the vehicle was at the gate. */}
        <Row k="Time at gate" v={took(trip.durationSec)} mono />
        <Row k="Items" v={`${trip.itemCount}${trip.manual ? ` · ${trip.manual} typed` : ""}${trip.duplicates ? ` · ${trip.duplicates} duplicate not counted` : ""}`} />
        {trip.completeness && (
          <Row k="Against the plan"
               v={`${trip.completeness.scanned} of ${trip.completeness.total}`} />
        )}
      </div>

      {/* ── What the plan expected and the truck did not carry ───────────
          The barcodes, not a count. A number tells a manager something went
          wrong; the list tells them which pallet to go and look at, which is
          the only version anybody can act on the next morning. */}
      {trip.completeness && trip.completeness.missing.length > 0 && (
        <div className="card p-4 mb-5 border border-warning/30">
          <div className="flex items-center gap-2 mb-2">
            <Icon name="warning" size={17} />
            <b>{trip.completeness.missing.length} planned item
              {trip.completeness.missing.length === 1 ? "" : "s"} not scanned</b>
            {/* Silent through the pilot. A gap the guard never saw is evidence
                about the DATA; one they saw and closed anyway is evidence about
                the process, and the two must not be read as the same thing. */}
            <span className={`badge ${trip.completeness.warned ? "badge-medium" : "badge-info"} ml-auto`}>
              {trip.completeness.warned ? "guard was warned" : "recorded silently"}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {trip.completeness.missing.map((b) => (
              <span key={b} className="font-mono text-xs px-2 py-1 rounded bg-surface-elevated">{b}</span>
            ))}
          </div>
          {trip.completeness.unplanned > 0 && (
            <p className="text-xs text-text-muted mt-3">
              {trip.completeness.unplanned} scanned item
              {trip.completeness.unplanned === 1 ? "" : "s"} matched no planned line.
            </p>
          )}
        </div>
      )}

      {/* ── Items the guard took back ────────────────────────────────────
          Kept out of every count above, because a voided row must never
          inflate what moved — that is the whole reason it was voided. Shown
          anyway: a trip with six retractions is a trip worth asking about, and
          hidden entirely there was no way to notice. */}
      {trip.removed.length > 0 && (
        <div className="card p-4 mb-5 border border-border">
          <div className="flex items-center gap-2 mb-2">
            <Icon name="delete" size={16} />
            <b>{trip.removed.length} item{trip.removed.length === 1 ? "" : "s"} removed by the guard</b>
          </div>
          <div className="space-y-1">
            {trip.removed.map((r, i) => (
              <div key={i} className="flex items-baseline gap-3 text-xs">
                <span className="font-mono">{r.barcode ?? "—"}</span>
                <span className="text-text-muted">{r.reason ?? ""}</span>
                <span className="text-text-muted ml-auto tabular-nums">{clock(r.at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {trip.items.length > 0 && (
        <div className="flex items-center gap-3 mb-2">
          <b className="text-sm">Items</b>
          {lookup === "running" && (
            <span className="text-xs text-text-muted">Looking up order, ticket and customer…</span>
          )}
          {lookup === "failed" && (
            <span className="text-xs text-warning">Could not look up details just now — they will fill in on the next scheduled run.</span>
          )}
          <button className="btn btn-compact btn-secondary ml-auto" onClick={() => downloadTripCsv(trip)}>
            <Icon name="download" size={15} /> Download
          </button>
        </div>
      )}
      {trip.items.length === 0 ? <Empty text="No items on this trip." /> : (
        <div className="overflow-x-auto rounded-control border border-border">
          {/* GRIDLINES on every cell, and text that wraps where it is prose.
              Twelve columns in a modal only fit a laptop screen if names and
              products may take a second line; codes (SO, ticket, barcode,
              truck) stay on one, because a wrapped code is misread. */}
          <table className="w-full border-collapse text-[13px] leading-snug">
            <thead className="bg-surface-elevated">
              <tr>
                {[...REGISTER_COLUMNS.map((c) => c.label), "How", "Time"].map((h) => (
                  <th key={h} className="text-left align-bottom px-1.5 py-1.5 border border-border text-[11px] font-semibold uppercase tracking-wide text-text-muted">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trip.items.map((it) => (
                <tr key={it.id} className={`align-top${it.duplicateOf ? " opacity-60" : ""}`}>
                  {REGISTER_COLUMNS.map((c) => {
                    const v = c.value(trip, it);
                    return (
                      <td key={c.label}
                          className={`px-1.5 py-1.5 border border-border ${c.wrap ? (c.mono ? "min-w-[6rem] max-w-[9rem] break-words" : c.label === "Item Name" ? "min-w-[9rem] max-w-[15rem] break-words" : "min-w-[5.5rem] max-w-[12rem] break-words") : "whitespace-nowrap"} ${c.mono ? "font-mono text-[11.5px]" : ""} ${v ? "" : "text-text-muted"}`}>
                        {v ?? (c.lookedUp && it.lookupPending && lookup === "running" ? "…" : "—")}
                        {c.label === "Ticket ID" && v && it.lastKnown && (
                          <span className="badge badge-medium mt-1 font-sans block w-fit whitespace-nowrap"
                                title="No DT task within a few days of this scan. Showing the unit's most recent task instead.">
                            last known{it.taskDate ? ` · ${shortDate(it.taskDate).replace(/ \d{4}$/, "")}` : ""}
                          </span>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-1.5 py-1.5 border border-border min-w-[4.5rem] max-w-[8rem]">
                    <span className={`badge ${it.entryMethod === "scan" ? "badge-done" : "badge-medium"} mr-1 mb-1 inline-block`}>
                      {it.entryMethod}
                    </span>
                    {it.override && <span className="badge badge-high mr-1 mb-1 inline-block whitespace-nowrap" title={it.override}>override</span>}
                    {it.awaitingBarcode && <span className="badge badge-medium mr-1 mb-1 inline-block whitespace-nowrap">no barcode</span>}
                    {it.duplicateOf && (
                      <span className="badge badge-high mr-1 mb-1 inline-block whitespace-nowrap"
                            title={`Not counted: ${it.duplicateOf.reason} as the entry at ${clock(it.duplicateOf.ofScannedAt)}`}>
                        duplicate · {hhmm(it.duplicateOf.ofScannedAt)}
                      </span>
                    )}
                    {/* The photo is the ONLY evidence a manual entry or an
                        override carries. This drew a camera icon and offered
                        no way to open it, which is the same as not having
                        taken one. */}
                    {it.hasPhoto && (
                      <button className="btn-icon mr-1 align-middle" title="View photo"
                              onClick={() => setPhoto({ scanId: it.id, label: it.barcode ?? it.serialNo ?? "item" })}>
                        <Icon name="camera" size={14} />
                      </button>
                    )}
                  </td>
                  <td className="px-1.5 py-1.5 border border-border text-text-secondary whitespace-nowrap tabular-nums">{hms(it.scannedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Keyed by the scan, so opening a second photo MOUNTS a second viewer
          rather than resetting the first one's state from inside an effect. */}
      <PhotoViewer key={photo?.scanId ?? "none"} photo={photo} onClose={() => setPhoto(null)} />
    </Modal>
  );
}

/**
 * The register row, in the order the paper register and the ops team read it.
 * One list drives both the table and the download, so the file can never
 * quietly disagree with the screen.
 *
 * `lookedUp` marks the columns filled from Odoo/DT by barcode after the scan
 * rather than recorded at the gate — shown as "…" while the lookup runs. A
 * dash afterwards means no DT task matches this movement, which is common and
 * true (vendor stock, internal transfers), not a failure.
 */
const REGISTER_COLUMNS: {
  label: string; mono?: boolean; lookedUp?: boolean;
  /** Free text that may wrap onto a second line rather than widen the table. */
  wrap?: boolean;
  value: (trip: Trip, it: TripItem) => string | null;
}[] = [
  { label: "City", value: (t) => t.city || null },
  { label: "SO Number", mono: true, lookedUp: true, value: (_, i) => i.soDisplay },
  { label: "Ticket ID", mono: true, lookedUp: true, value: (_, i) => i.ticket },
  { label: "Customer Name", lookedUp: true, wrap: true, value: (_, i) => i.customer },
  { label: "Job Type", lookedUp: true, wrap: true, value: (_, i) => i.jobType },
  // A hand entry has no product to look up — a box of spares, a PP box, a
  // vendor delivery. Its kind and the guard's note ARE the item name, and
  // showing a dash there made the entry look like it was never recorded.
  { label: "Item Name", lookedUp: true, wrap: true, value: (_, i) => i.itemName ?? manualName(i) },
  // Dropped when the register columns replaced the old table, which hid that
  // "PO-TYUI-BJ900" was ten washing machines.
  { label: "Qty", value: (_, i) => String(i.quantity) },
  { label: "Movement Type", value: (t) => (t.direction === "OUT" ? "Outward" : "Inward") },
  // Raw scanned spelling — never the fold.
  { label: "Barcode", mono: true, value: (_, i) => i.barcode ?? i.serialNo },
  { label: "Agent", wrap: true, value: (t) => t.driverName },
  // Wraps at its own hyphens ("VIPIN-EV-" / "DL1LAT4654"): DT's transport text
  // is the widest thing in the row and repeats on every line of the trip.
  { label: "Transport", mono: true, wrap: true, value: (t) => t.vehicleNo },
];

/**
 * The trip's items as a CSV a manager can open in Excel.
 *
 * Two details that are not decoration. A leading BOM, or Excel reads a Hindi
 * customer name as mojibake. And any cell starting with = + - @ is prefixed
 * with an apostrophe: a barcode comes from a sticker anyone can print, and a
 * spreadsheet treats "=HYPERLINK(...)" in a cell as a formula to run.
 */
/** "11:45:07" in IST, 24-hour — the item table's time column, where AM/PM cost width. */
const hms = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata" });
/** "11:45" in IST — for tags, where the seconds and AM/PM cost width. */
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });

/** "customer_return" → "Customer return", plus the guard's note if any. */
function manualName(i: TripItem): string | null {
  if (i.entryMethod !== "manual") return null;
  // Operations' names where they differ from the stored kind (14 Sep 2026).
  const named: Record<string, string> = { vendor_goods: "New PO" };
  const kind = i.itemKind.replace(/_/g, " ");
  const label = named[i.itemKind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
  return i.notes ? `${label} · ${i.notes}` : label;
}

/** "2026-03-08" → "8 Mar 2026". Parsed as a plain date: no timezone shift. */
const shortDate = (d: string) => {
  const [y, m, day] = d.slice(0, 10).split("-").map(Number);
  return `${day} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m - 1]} ${y}`;
};

function downloadTripCsv(trip: Trip) {
  const cell = (v: string | null | undefined) => {
    let s = v ?? "";
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // "Details From" travels with the file: a spreadsheet row loses the badge,
  // and a March ticket in a September export must still say it is last known.
  const header = [...REGISTER_COLUMNS.map((c) => c.label), "Details From", "Duplicate", "Entry", "Scanned At"];
  const lines = trip.items.map((it) => [
    ...REGISTER_COLUMNS.map((c) => c.value(trip, it)),
    !it.ticket && !it.jobType && !it.customer ? ""
      : it.lastKnown ? `Last known task${it.taskDate ? ` (${shortDate(it.taskDate)})` : ""}` : "This movement",
    // A spreadsheet row loses the greyed-out look, so the file says it outright.
    it.duplicateOf ? `Yes — ${it.duplicateOf.reason} as ${new Date(it.duplicateOf.ofScannedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} entry; not counted` : "",
    it.entryMethod,
    new Date(it.scannedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
  ].map(cell).join(","));
  const csv = "\uFEFF" + [header.map(cell).join(","), ...lines].join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  const day = new Date(trip.openedAt).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  a.href = url;
  a.download = `gate-trip-${trip.vehicleNo.replace(/[^A-Za-z0-9-]/g, "")}-${day}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * One evidence photograph, fetched only when somebody asks to see it.
 *
 * NOT SIGNED WITH THE LIST. A day carries hundreds of rows and a manager opens
 * two of them; signing every photo up front would be hundreds of storage round
 * trips to render a table. The list says only whether a photo exists.
 *
 * It also distinguishes the two ways this can come back empty, because they
 * mean completely different things: a row with no photograph is normal, and a
 * row whose photograph is recorded but missing from storage is a hole in the
 * evidence somebody should know about.
 */
function PhotoViewer({ photo, onClose }: {
  /** An item photo (scanId) or an attendance selfie (checkId). */
  photo: { scanId?: string; checkId?: string; label: string } | null; onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!photo) return;
    let alive = true;
    const q = photo.checkId ? `checkId=${encodeURIComponent(photo.checkId)}` : `scanId=${encodeURIComponent(photo.scanId ?? "")}`;
    fetch(`/api/gate/photo?${q}`, { credentials: "same-origin" })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (j.url) setUrl(j.url);
        else setProblem(j.reason ?? j.error ?? "The photo could not be loaded.");
      })
      .catch(() => { if (alive) setProblem("Could not reach the server."); });
    return () => { alive = false; };
  }, [photo]);

  if (!photo) return null;
  return (
    <Modal open onClose={onClose} title="Photo" subtitle={photo.label}
           size="md" level="stacked">
      {problem ? (
        <p className="text-sm text-text-muted">{problem}</p>
      ) : url ? (
        /* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed storage URL; next/image cannot optimise what it cannot refetch */
        <img src={url} alt={photo.label} className="w-full rounded-control border border-border" />
      ) : (
        <p className="text-sm text-text-muted">Loading…</p>
      )}
    </Modal>
  );
}

/* ── Attendance ─────────────────────────────────────────────────────── */
interface FaceMark { checkId: string; verdict: string; score: number | null; hasSelfie: boolean; review: string | null }
interface AttendanceRow {
  guardId: string; name: string; city: string | null; shifts: number;
  firstIn: { at: string; geoOk: boolean | null; face: FaceMark | null } | null;
  lastOut: { at: string | null; geoOk: boolean | null; face: FaceMark | null; auto: boolean } | null;
  onDuty: boolean; minutes: number | null;
}

const istToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

/**
 * Who came in, when, and whether the face matched — per calendar day.
 *
 * First sign-in and last sign-out only, as asked: a guard who steps out and
 * back in has several shifts, but the attendance question is when the day
 * started and ended. A sign-out without a face is labelled as such rather than
 * shown as a pass — it predates the end-of-shift photo, or the nightly sweep
 * closed it because nobody signed out at all.
 */
function Attendance({ user }: { user: SessionUser }) {
  const [date, setDate] = useState(istToday());
  const [city, setCity] = useState<string>(user.city ?? "");
  const [d, setD] = useState<{ date: string; totals: { guards: number; present: number; onDuty: number; signedOutWithoutFace: number; notSignedOut: number }; rows: AttendanceRow[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [photo, setPhoto] = useState<{ checkId: string; label: string } | null>(null);

  const load = useCallback(() => {
    const q = new URLSearchParams({ date });
    if (city) q.set("city", city);
    fetch(`/api/gate/attendance?${q}`, { credentials: "same-origin" })
      .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`); return j; })
      .then((j) => { setErr(null); setD(j); })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [date, city]);
  useEffect(() => { load(); }, [load]);

  const faceBadge = (f: FaceMark | null, who: string, when: string) => {
    if (!f) return <span className="badge badge-medium">no face</span>;
    const tone = f.verdict === "pass" ? "badge-done" : f.verdict === "fail" ? "badge-high" : "badge-medium";
    const label = f.verdict === "pass" ? "face matched" : f.verdict === "fail" ? "face mismatch"
      : f.verdict === "no_face" ? "no face seen" : "needs review";
    return (
      <span className="inline-flex items-center gap-1">
        <span className={`badge ${tone}`} title={f.score !== null ? `match score ${f.score.toFixed(3)} (lower is closer)` : undefined}>{label}</span>
        {f.hasSelfie && (
          <button className="btn-icon" title="View photo" onClick={() => setPhoto({ checkId: f.checkId, label: `${who} · ${when}` })}>
            <Icon name="camera" size={14} />
          </button>
        )}
      </span>
    );
  };
  const hm = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
  const dur = (m: number | null) => (m === null ? "—" : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`);

  return (
    <div className="space-y-5">
      <div className="card p-3 flex flex-wrap gap-2 items-center">
        <input type="date" value={date} max={istToday()} onChange={(e) => setDate(e.target.value)}
          className="h-9 px-2 rounded-control border border-border bg-surface-card text-sm" />
        {!user.city && (
          <select value={city} onChange={(e) => setCity(e.target.value)}
            className="h-9 px-2 rounded-control border border-border bg-surface-card text-sm">
            <option value="">All cities</option>
            {CITIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        <span className="ml-auto text-xs text-text-muted">Calendar day, IST. A night shift counts on the day it started.</span>
      </div>

      {err && <ErrorState what="attendance" detail={err} onRetry={load} />}
      {!d && !err && <p className="text-text-muted text-sm">Loading…</p>}

      {d && !err && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Guards" value={d.totals.guards} />
            <Stat label="Present" value={d.totals.present} />
            <Stat label="Still on duty" value={d.totals.onDuty} />
            <Stat label="Did not sign out" value={d.totals.notSignedOut}
                  tone={d.totals.notSignedOut > 0 ? "warn" : "ok"} />
          </div>

          {d.rows.length === 0 ? <Empty text="No guards on the roster for this city." /> : (
            <div className="card overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead className="bg-surface-elevated">
                  <tr>
                    {["Guard", "First sign-in", "Face at sign-in", "Last sign-out", "Face at sign-out", "Hours", "Shifts"].map((h) => (
                      <th key={h} className="text-left px-3 py-2 border border-border text-xs uppercase tracking-wide text-text-muted whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.guardId} className={r.firstIn ? "" : "text-text-muted"}>
                      <td className="px-3 py-2 border border-border font-medium whitespace-nowrap">
                        {r.name}{!user.city && r.city ? <span className="text-xs text-text-muted ml-1">· {r.city}</span> : null}
                      </td>
                      <td className="px-3 py-2 border border-border tabular-nums whitespace-nowrap">
                        {r.firstIn ? hm(r.firstIn.at) : <span className="badge badge-medium">absent</span>}
                        {r.firstIn?.geoOk === false && <span className="badge badge-medium ml-1" title="Outside the gate's geofence">off-site</span>}
                      </td>
                      <td className="px-3 py-2 border border-border whitespace-nowrap">
                        {r.firstIn ? faceBadge(r.firstIn.face, r.name, `sign-in ${hm(r.firstIn.at)}`) : "—"}
                      </td>
                      <td className="px-3 py-2 border border-border tabular-nums whitespace-nowrap">
                        {r.lastOut?.auto
                          ? <span className="badge badge-high" title="Nobody signed out. The shift was closed automatically 16 hours after sign-in, so there is no real sign-out time.">not signed out</span>
                          : r.lastOut?.at ? hm(r.lastOut.at) : r.onDuty ? <span className="badge badge-info">on duty</span> : "—"}
                        {r.lastOut?.geoOk === false && <span className="badge badge-medium ml-1" title="Outside the gate's geofence">off-site</span>}
                      </td>
                      <td className="px-3 py-2 border border-border whitespace-nowrap">
                        {r.lastOut && !r.lastOut.auto && r.lastOut.at ? faceBadge(r.lastOut.face, r.name, `sign-out ${hm(r.lastOut.at)}`) : "—"}
                      </td>
                      <td className="px-3 py-2 border border-border tabular-nums whitespace-nowrap">{dur(r.minutes)}</td>
                      <td className="px-3 py-2 border border-border tabular-nums">{r.shifts || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <PhotoViewer photo={photo} onClose={() => setPhoto(null)} />
    </div>
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
      {loadErr && <ErrorState what="guards" detail={loadErr} onRetry={load} />}
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

  /**
   * A photo chosen from disk, rather than taken here.
   *
   * THE FAILURE THIS IS WRITTEN AROUND. An image the browser cannot decode
   * reached the face detector and killed the handler without saying anything:
   * the old code awaited a promise that `onload` and `onerror` BOTH resolved,
   * so a failed decode carried on to describe() as a zero-dimension image and
   * face-api threw `Dimensions.constructor - expected width and height to be
   * valid numbers`. setErr never ran, so the form went on quietly reading
   * "Needs a photo" and a manager had nothing to act on.
   *
   * A try/catch here does NOT save it — measured. face-api throws that one
   * from inside its own task chain, off a promise this caller never awaits, so
   * it arrives as an uncaught page error no matter what wraps the call. The
   * only reliable place to stop it is BEFORE the detector: an image that
   * decoded has a natural size, and one that did not has zero.
   *
   * HEIC is the case that will actually happen. The picker takes `image/*`,
   * which on an iPhone or a Mac offers HEIC, and no browser but Safari decodes
   * it. It is refused with its name in the message rather than converted —
   * a decision taken on 12 Sep 2026 — because the manager can re-export or
   * switch the phone to "Most Compatible" in seconds, and carrying a decoder
   * for it would be a permanent dependency serving one file format.
   *
   * The catch stays anyway, for everything that is not that: a corrupt file, a
   * model that failed to load, an out-of-memory on a very large image. Silence
   * is the one outcome this function is not allowed to produce.
   */
  async function readPhotoFile(file: File) {
    setBusy(true); setErr(null);
    let objectUrl: string | null = null;
    try {
      const { describe, toArray } = await import("@/lib/gate/client/face");
      const { compress } = await import("@/lib/gate/client/media");
      const img = document.createElement("img");
      objectUrl = URL.createObjectURL(file);
      img.src = objectUrl;
      const decoded = await new Promise<boolean>((r) => {
        img.onload = () => r(true);
        img.onerror = () => r(false);
      });

      // Zero dimensions mean the bytes never became an image, whatever the
      // event said. Checked as well as the event because a browser can fire
      // load on a file it then fails to rasterise.
      if (!decoded || !img.naturalWidth || !img.naturalHeight) {
        setErr(`${file.name} could not be opened as an image. iPhone photos are often HEIC, `
             + `which browsers cannot read — export it as JPG, or set Camera → Formats → `
             + `"Most Compatible" on the phone.`);
        return;
      }

      const d = await describe(img);
      if (!d) { setErr("No face found in that photo. Try one taken straight on, in good light."); return; }

      // Shrunk to match what the camera path stores. An uploaded file went to
      // storage at its original size, so a 4MB phone photo was kept whole for
      // a 32px avatar. The DESCRIPTOR is still computed from the full-size
      // image above, where the detail is worth having.
      const small = await compress(img, 640, 0.8).catch(() => file);
      keepShot(small, toArray(d));
    } catch (e) {
      setErr(e instanceof Error ? `That photo could not be read: ${e.message}`
                                : "That photo could not be read.");
    } finally {
      // In a finally because the old revoke sat on the success path and leaked
      // one object URL for every photo that failed.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setBusy(false);
    }
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
      //
      // THE FAILURE HERE USED TO BE SWALLOWED — `.catch(() => {})` — and the
      // form then said "added" regardless. So a manager who watched the upload
      // fail was told it had worked, and the guard's reference photo simply did
      // not exist. Worse, the profile row already claimed one, so nothing
      // downstream could tell the difference either.
      if (shot && j.referencePhotoUpload) {
        const { getSupabaseClient } = await import("@/lib/supabase/client");
        const { error: upErr } = await getSupabaseClient().storage
          .from(j.referencePhotoUpload.bucket)
          .uploadToSignedUrl(j.referencePhotoUpload.path, j.referencePhotoUpload.token, shot.blob);
        if (upErr) {
          // The guard EXISTS by now — the account and PIN were created before
          // this ran. Saying "could not add" would be a lie and would invite a
          // second attempt that fails on a duplicate. So: they are added, the
          // photo is not, and the photo can be attached again from the guard's
          // own row.
          await fetch("/api/gate/guards", {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ guardId: j.guardId, referencePhotoFailed: true }),
          }).catch(() => {});
          setErr(`${name} was added, but the photo did not upload (${upErr.message}). `
                 + `Open their row and add it again.`);
          return;
        }
      } else if (shot && !j.referencePhotoUpload) {
        setErr(`${name} was added, but the photo could not be saved: `
               + `${j.photoProblem ?? "storage refused an upload link"}.`);
        return;
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
          {/* THE LABEL HAS TO SAY WHAT THE INPUT INSIDE IT IS DOING.
              A disabled <input> inside a <label> swallows the click and opens
              no file dialog — measured in WebKit and Chromium — so while the
              6.7MB model loaded, this looked completely ready, did nothing at
              all when pressed, and left the form still reading "Needs a photo".
              The button above it said "Preparing…" through the same window,
              which is what made the pair actively misleading rather than
              merely slow. Now both wear the same state. */}
          <label className={`btn btn-secondary ${busy || model === "loading"
            ? "opacity-60 pointer-events-none" : "cursor-pointer"}`}
            aria-disabled={busy || model === "loading"}>
            <Icon name="cloud_upload" size={17} />
            {model === "loading" ? "Preparing…" : busy ? "Reading face…" : "Upload photo"}
            <input type="file" accept="image/*" className="hidden"
              disabled={busy || model === "loading"}
              onChange={(e) => {
                const f = e.target.files?.[0];
                // Cleared so picking the SAME file again still fires a change.
                // Without this, "let me just try that once more" was a click
                // that could not possibly do anything — the worst thing to
                // hand someone whose first attempt already failed silently.
                e.target.value = "";
                if (f) void readPhotoFile(f);
              }} />
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
  // Enrolling a phone from the guard's own row.
  //
  // The Devices tab still does this and is untouched — that is the right place
  // to enrol a spare handset for a gate. But the common case is a person
  // standing in front of you needing a phone, and finding their record only to
  // be sent to another tab to type their city back in is friction for nothing.
  // A phone still belongs to a GATE rather than to a guard; this only saves
  // choosing the gate, because the guard's row already knows it.
  const [pairing, setPairing] = useState<{ url: string; label: string } | null>(null);
  const [copied, setCopied] = useState(false);
  if (!guard) return null;

  async function enrolPhone() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/gate/enrol", {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ city: guard!.city, deviceLabel: `${guard!.name}'s phone` }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.error ?? `Could not enrol a phone (HTTP ${r.status})`); return; }
      setPairing({ url: j.pairingUrl, label: j.deviceId });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not reach the server.");
    } finally { setBusy(false); }
  }

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
          <button className="btn btn-secondary" disabled={busy} onClick={enrolPhone}>
            <Icon name="upload_file" size={16} /> Enrol a phone
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

      {/* Shown ONCE. The token is stored hashed and cannot be retrieved, so a
          lost phone is revoked and enrolled again rather than recovered. */}
      {pairing && (
        <div className="card p-4 mt-5 space-y-2 border border-accent/30">
          <h3 className="font-headline text-base">Open this link on the phone</h3>
          <p className="text-xs text-text-muted">
            It appears once. If it is lost, enrol the phone again and revoke this one.
          </p>
          <div className="flex gap-2 items-center flex-wrap">
            <code className="text-xs bg-surface-elevated rounded-control px-2 py-1.5 break-all flex-1 min-w-[200px]">
              {pairing.url}
            </code>
            <button className="btn btn-secondary" onClick={() => {
              navigator.clipboard.writeText(pairing.url).then(
                () => { setCopied(true); setTimeout(() => setCopied(false), 2000); },
                () => setErr("Could not copy — select the link and copy it by hand."),
              );
            }}>
              <Icon name={copied ? "check" : "content_copy"} size={16} /> {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="text-xs text-text-muted">
            Enrolled for the {guard.city} gate. Any guard at that gate can sign in on it.
          </p>
        </div>
      )}
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

  if (loadErr) return <ErrorState what="the gates" detail={loadErr} onRetry={load} />;

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

  if (err) return <ErrorState what="the enrolled phones" detail={err} onRetry={load} />;
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
/**
 * Three different questions, three sections.
 *
 * The tab used to be one list of face checks called "Reviews", which quietly
 * implied that a face check was the only thing worth reviewing. It is not:
 * a guard checking in from the wrong place and a row the gate refused outright
 * are both things somebody should see, and neither had anywhere to appear.
 *
 * They are separated rather than merged because they are answered differently.
 * A face check is a DECISION — a human says yes or no. The other two are
 * READINGS: the useful response to a refused manual entry is to go and add it
 * properly, and to an out-of-range check-in is usually to go and confirm where
 * the gate actually is.
 */
type ReviewSection = "face" | "location" | "scanning";

interface LocationFlag {
  shift_id: string; guard_name: string; city: string; business_date: string;
  checked_in_at: string; metres_from_gate: number; radius_m: number;
  pin_unconfirmed: boolean;
}
interface Rejection {
  id: string; client_id: string; kind: string; city: string; reason: string;
  summary: Record<string, unknown> | null; attempts: number;
  business_date: string | null; rejected_at: string;
  app_users?: { name?: string } | null;
}

function Reviews() {
  const [section, setSection] = useState<ReviewSection>("face");
  const [flags, setFlags] = useState<{ location: LocationFlag[]; scanning: Rejection[] } | null>(null);
  const [flagErr, setFlagErr] = useState<string | null>(null);
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

  // The other two sections come from one call — they are read together and
  // never acted on individually, so two round trips would buy nothing.
  useEffect(() => {
    const q = new URLSearchParams();
    if (date) q.set("date", date);
    fetch(`/api/gate/flags?${q}`, { credentials: "same-origin" })
      .then((r) => r.json())
      .then((j) => {
        setFlags({ location: j.location ?? [], scanning: j.scanning ?? [] });
        setFlagErr(j.locationError ?? j.scanningError ?? null);
      })
      .catch((e) => setFlagErr(e instanceof Error ? e.message : String(e)));
  }, [date]);

  async function decide(id: string, decision: "accepted" | "rejected") {
    await fetch("/api/gate/reviews", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      credentials: "same-origin", body: JSON.stringify({ id, decision }),
    });
    load();
  }

  const counts = {
    face: rows.length,
    location: flags?.location.length ?? 0,
    scanning: flags?.scanning.length ?? 0,
  };

  return (
    <div className="space-y-4">
      {/* Three sections, because they are three different questions. The counts
          sit on the buttons so a section with something waiting is visible
          without opening it — a queue nobody knows to open is not a queue. */}
      <div className="bg-surface-elevated rounded-control p-1 flex flex-wrap gap-1">
        {([["face", "Face checks"], ["location", "Location"], ["scanning", "Refused items"]] as const)
          .map(([v, label]) => (
            <button key={v} onClick={() => setSection(v)}
              className={section === v
                ? "px-4 py-1.5 text-sm font-medium rounded-control bg-surface-card shadow-card flex items-center gap-2"
                : "px-4 py-1.5 text-sm text-text-secondary rounded-control flex items-center gap-2"}>
              {label}
              {counts[v] > 0 && (
                <span className={`badge ${v === "face" ? "badge-medium" : "badge-high"}`}>{counts[v]}</span>
              )}
            </button>
          ))}
      </div>

      {flagErr && section !== "face" && (
        <div className="card p-3 text-sm text-danger border border-danger/30">{flagErr}</div>
      )}

      {/* ── Location ────────────────────────────────────────────────────── */}
      {section === "location" && (
        <>
          <p className="text-text-muted text-sm">
            Check-ins whose GPS fell outside the gate. A question rather than a verdict:
            a phone inside a metal warehouse drifts, and none of the gate pins has been
            confirmed on site yet.
          </p>
          {counts.location === 0 ? (
            <Empty text="No check-ins outside a gate." />
          ) : (
            <div className="card overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>{["Guard", "Gate", "Distance", "Allowed", "Checked in", ""].map((h) => (
                    <th key={h} className="text-left px-4 py-2.5 text-xs uppercase tracking-wide text-text-muted whitespace-nowrap">{h}</th>
                  ))}</tr>
                </thead>
                <tbody>
                  {flags!.location.map((f) => (
                    <tr key={f.shift_id} className="border-t border-border">
                      <td className="px-4 py-2.5 font-medium text-text-primary">{f.guard_name}</td>
                      <td className="px-4 py-2.5">{f.city}</td>
                      <td className="px-4 py-2.5 tabular-nums">
                        <span className="badge badge-high">{Math.round(f.metres_from_gate)} m</span>
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-text-muted">{f.radius_m} m</td>
                      <td className="px-4 py-2.5 text-text-secondary whitespace-nowrap">{time(f.checked_in_at)}</td>
                      <td className="px-4 py-2.5">
                        {/* The caveat travels with the row. Reading a flag as
                            damning when the pin behind it was decoded from a
                            Plus Code and never checked would blame a guard for
                            our own missing homework. */}
                        {f.pin_unconfirmed && (
                          <span className="badge badge-medium" title="This gate's coordinates came from a Plus Code and nobody has confirmed them on site.">
                            gate pin unconfirmed
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ── Refused items ───────────────────────────────────────────────── */}
      {section === "scanning" && (
        <>
          <p className="text-text-muted text-sm">
            Rows the gate would not accept, and why. These never reached the record —
            the item still needs adding properly.
          </p>
          {counts.scanning === 0 ? (
            <Empty text="Nothing was refused." />
          ) : (
            <div className="space-y-2">
              {flags!.scanning.map((r) => (
                <div key={r.id} className="card p-4">
                  <div className="flex items-start gap-3 flex-wrap">
                    <span className="badge badge-high">{r.kind}</span>
                    <b className="text-text-primary">{r.reason}</b>
                    {/* A climbing count is the signal that a phone is stuck
                        retrying something it can never get accepted. */}
                    {r.attempts > 1 && (
                      <span className="badge badge-medium" title="The phone has re-sent this and it keeps being refused.">
                        tried {r.attempts}×
                      </span>
                    )}
                    <span className="ml-auto text-xs text-text-muted whitespace-nowrap">
                      {r.app_users?.name ?? "—"} · {r.city} · {time(r.rejected_at)}
                    </span>
                  </div>
                  {r.summary && (
                    <div className="mt-2 text-xs text-text-muted font-mono break-all">
                      {Object.entries(r.summary)
                        .filter(([, v]) => v !== null && v !== "")
                        .map(([k, v]) => `${k}: ${String(v)}`).join("  ·  ")}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {section === "face" && (
      <>
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

      {loadErr && <ErrorState what="the photo checks" detail={loadErr} onRetry={load} />}
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
      </>
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
function Empty({ text }: { text: string }) {
  return <div className="card p-8 text-center text-text-muted text-sm">{text}</div>;
}
