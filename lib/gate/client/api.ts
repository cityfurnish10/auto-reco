// Talking to the server, and draining the outbox.
//
// The device token lives in localStorage rather than a cookie: the phone is
// paired once and then behaves like a dedicated terminal, and a cookie would be
// cleared by the browser cleanup a personal phone gets regularly.

import * as outbox from "./outbox";

const TOKEN_KEY = "gate.deviceToken";
// The guard signed in on this phone. Separate from the device token because
// they change on different clocks: the device is paired once and stays, the
// guard changes every shift.
const GUARD_KEY = "gate.guardId";

export const getToken = () =>
  typeof window === "undefined" ? null : localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export const getGuardId = () =>
  typeof window === "undefined" ? null : localStorage.getItem(GUARD_KEY);
export const setGuardId = (id: string) => localStorage.setItem(GUARD_KEY, id);
export const clearGuardId = () => localStorage.removeItem(GUARD_KEY);

function headers(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${getToken() ?? ""}` };
}

export interface GuardOption {
  guardId: string; name: string; employeeCode: string | null;
  /** 128-float face signature. No photograph is ever sent to a device. */
  descriptor: number[] | null;
  enrolled: boolean;
}

/** Who may work at this gate. Fetched before sign-in, so no guard id yet. */
export async function rosterFor(): Promise<{ site: { city: string; code: string }; guards: GuardOption[] }> {
  const r = await fetch("/api/gate/session", { headers: headers(), cache: "no-store" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
  return r.json();
}

export interface Bootstrap {
  guard: { id: string; name: string } | null;
  businessDate: string;
  site: { code: string; label: string; lat: number; lng: number; radiusM: number } | null;
  config: { outwardPhotoSampleRate: number; expectedCheckLive: boolean };
  openTrip: { id: string; client_trip_id: string; direction: "IN" | "OUT"; vehicle_no: string; opened_at: string } | null;
  openShift: { id: string; client_shift_id: string; checked_in_at: string } | null;
  expected: { barcode: string; barcode_canon: string; direction: "IN" | "OUT"; product: string | null; so_number: string | null; ticket_id: string | null; customer: string | null }[];
  expectedCount: number;
}

export async function bootstrap(): Promise<Bootstrap> {
  const g = getGuardId();
  const r = await fetch(`/api/gate/bootstrap${g ? `?guardId=${encodeURIComponent(g)}` : ""}`,
    { headers: headers(), cache: "no-store" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
  return r.json();
}

export async function signIn(guardId: string, pin: string): Promise<boolean> {
  try {
    const r = await fetch("/api/gate/session", {
      method: "POST", headers: headers(), body: JSON.stringify({ guardId, pin }),
    });
    if (r.ok) { setGuardId(guardId); return true; }
    // A definite 401 is a genuinely wrong PIN and must be refused.
    if (r.status === 401) return false;
    throw new Error(`HTTP ${r.status}`);
  } catch {
    // The server is unreachable. A guard cannot be locked out of a gate by a
    // dead connection, so sign-in proceeds — the check-in selfie still has to
    // match this guard's own reference photo, which is the real control.
    setGuardId(guardId);
    return true;
  }
}

export interface SyncResult {
  sent: number; stored: number; duplicate: number; rejected: number;
  photosUploaded: number; offline: boolean;
}

/**
 * Drain the outbox.
 *
 * Order matters and is not incidental: trips before scans, so a batch is
 * order-independent on the server; then photos, because a record without its
 * image is still a record, while an image without its record is nothing.
 */
export async function drain(): Promise<SyncResult> {
  const empty: SyncResult = { sent: 0, stored: 0, duplicate: 0, rejected: 0, photosUploaded: 0, offline: false };
  const items = await outbox.pending();
  if (items.length === 0) return empty;

  const pick = (k: outbox.Kind) => items.filter((i) => i.kind === k).map((i) => i.payload);
  const body = {
    // Attribution travels with the batch: every row lands under the guard who
    // was signed in, not the phone's owner.
    guardId: getGuardId(),
    trips: pick("trip"), scans: pick("scan"),
    shifts: pick("shift"), faceChecks: pick("face"),
  };

  let json: {
    trips?: { clientId: string; status: string; reason?: string }[];
    scans?: { clientId: string; status: string; reason?: string }[];
    shifts?: { clientId: string; status: string; reason?: string }[];
    faceChecks?: { clientId: string; status: string; reason?: string }[];
    photos?: { clientId: string; path: string; token?: string }[];
    selfies?: { clientId: string; path: string; token?: string }[];
    bucket?: string; selfieBucket?: string;
  };
  try {
    const r = await fetch("/api/gate/sync", {
      method: "POST", headers: headers(), body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    json = await r.json();
  } catch {
    // Offline or the server is unhappy. NOTHING is removed — the queue is the
    // only copy of these movements until the server says otherwise.
    await outbox.bumpAttempts(items.map((i) => i.clientId));
    return { ...empty, sent: items.length, offline: true };
  }

  const res: SyncResult = { ...empty, sent: items.length };
  for (const group of [json.trips, json.scans, json.shifts, json.faceChecks]) {
    for (const o of group ?? []) {
      if (o.status === "stored") { res.stored++; }
      else if (o.status === "duplicate") { res.duplicate++; await outbox.remove(o.clientId); }
      else { res.rejected++; await outbox.markRejected(o.clientId, o.reason ?? "rejected"); }
    }
  }

  // Images last, and each one on its own: a failed upload must not lose the
  // movement that was already accepted.
  const slots = [
    ...(json.photos ?? []).map((p) => ({ ...p, bucket: json.bucket! })),
    ...(json.selfies ?? []).map((p) => ({ ...p, bucket: json.selfieBucket! })),
  ];
  const { getSupabaseClient } = await import("../../supabase/client");
  for (const slot of slots) {
    if (!slot.token) continue;
    const blob = await outbox.getBlob(slot.clientId);
    if (!blob) continue;
    try {
      const sb = getSupabaseClient();
      const { error } = await sb.storage.from(slot.bucket)
        .uploadToSignedUrl(slot.path, slot.token, blob);
      if (!error) res.photosUploaded++;
    } catch { /* retried on the next drain */ }
  }

  // Only now clear what the server confirmed. Doing this before the images
  // would drop the blob a moment before we tried to upload it.
  for (const group of [json.trips, json.scans, json.shifts, json.faceChecks]) {
    for (const o of group ?? []) if (o.status === "stored") await outbox.remove(o.clientId);
  }

  return res;
}
