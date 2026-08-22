// Authenticating a phone at the gate.
//
// The device holds a long-lived token issued at enrolment; the PIN never leaves
// the phone. That combination is deliberate: opening the app needs no network,
// so a guard is never locked out at a gate at night by an expired session, and
// revoking a phone is one row rather than a session hunt.
//
// The token is stored HASHED. A leaked database dump must not hand someone a
// working set of gate credentials, and we never need the original back — every
// check is "does this presented token hash to a row we hold".

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { City } from "../sample-data";

/** SHA-256, hex. Fast is fine and correct here: the token is 256 bits of
 *  randomness, not a human-chosen secret, so there is nothing to brute-force
 *  and no reason to pay bcrypt's cost on every scan sync. */
export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

/** A PIN is short and human-chosen, so it DOES need a slow hash. Salted and
 *  iterated; the digest carries its own salt so rotation needs no migration. */
export function hashPin(pin: string, salt?: string): string {
  const s = salt ?? randomBytes(16).toString("hex");
  let h = createHash("sha256").update(s + pin).digest();
  for (let i = 0; i < 50_000; i++) h = createHash("sha256").update(h).digest();
  return `v1$${s}$${h.toString("hex")}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [v, salt] = stored.split("$");
  if (v !== "v1" || !salt) return false;
  const a = Buffer.from(hashPin(pin, salt));
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const newDeviceToken = () => randomBytes(32).toString("base64url");

/** WHICH GATE is talking to us. Says nothing about who is holding the phone. */
export interface DeviceIdentity {
  deviceRowId: string;
  deviceId: string;
  city: City;
  siteCode: string;
}

/** A device plus the guard signed in on it. What every write is attributed to. */
export interface GateIdentity extends DeviceIdentity {
  guardId: string;
  guardName: string;
}

/**
 * Resolve `Authorization: Bearer <device token>` to a guard.
 *
 * Returns null for anything wrong — unknown token, revoked device, deactivated
 * guard — without saying which. A gate device gets one answer: yes or no.
 */
export async function identifyDevice(
  admin: SupabaseClient,
  authHeader: string | null
): Promise<DeviceIdentity | null> {
  const token = authHeader?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  const { data, error } = await admin
    .from("gate_devices")
    .select("id, device_id, city, site_code")
    .eq("token_hash", hashToken(token))
    .eq("status", "active")
    .maybeSingle();

  if (error || !data) return null;
  return {
    deviceRowId: data.id as string,
    deviceId: data.device_id as string,
    city: data.city as City,
    siteCode: data.site_code as string,
  };
}

/**
 * Attach the guard the phone says is signed in.
 *
 * The claim is CHECKED, not trusted: the guard must have an active profile in
 * this device's own city. That stops a device in Pune filing work against a
 * Delhi guard, which is the mistake a shared codebase makes by accident.
 *
 * It does NOT prove the person holding the phone is that guard — the PIN is a
 * local unlock, and impersonating a colleague is caught by the check-in selfie
 * failing to match that profile's reference photo. Recorded here so the next
 * reader knows exactly how far this check reaches.
 */
export async function withGuard(
  admin: SupabaseClient,
  device: DeviceIdentity,
  guardId: string | null | undefined
): Promise<GateIdentity | null> {
  if (!guardId) return null;
  const { data } = await admin
    .from("guard_profiles")
    .select("guard_id, city, status, app_users!guard_id!inner(name,status)")
    .eq("guard_id", guardId)
    .eq("city", device.city)
    .eq("status", "active")
    .maybeSingle();
  if (!data) return null;
  const u = (data as { app_users?: { name?: string; status?: string } }).app_users;
  // A guard who has left is deactivated in user management, not de-profiled.
  if (!u || u.status !== "active") return null;
  return { ...device, guardId, guardName: u.name ?? "" };
}

/** The sign-in list for a gate: who may work at this device's city today. */
export async function guardsForDevice(admin: SupabaseClient, device: DeviceIdentity) {
  const { data } = await admin
    .from("guard_profiles")
    .select("guard_id, reference_descriptor, employee_code, app_users!guard_id!inner(name,status)")
    .eq("city", device.city)
    .eq("status", "active");
  return ((data ?? []) as Record<string, unknown>[])
    .filter((r) => (r.app_users as { status?: string })?.status === "active")
    .map((r) => ({
      guardId: r.guard_id as string,
      name: ((r.app_users as { name?: string })?.name) ?? "",
      employeeCode: (r.employee_code as string) ?? null,
      // The signature, not the picture. See lib/gate/client/face.ts for why:
      // a shared device must not end up caching colleagues' photographs.
      descriptor: (r.reference_descriptor as number[]) ?? null,
    }));
}

/** Verify a guard's own PIN. */
export async function verifyGuardPin(
  admin: SupabaseClient, guardId: string, pin: string
): Promise<boolean> {
  const { data } = await admin
    .from("guard_profiles").select("pin_hash").eq("guard_id", guardId)
    .eq("status", "active").maybeSingle();
  return !!data?.pin_hash && verifyPin(pin, data.pin_hash as string);
}

/** Touch last_seen_at. Best-effort — never fail a sync over telemetry. */
export async function markDeviceSeen(admin: SupabaseClient, deviceRowId: string) {
  await admin
    .from("gate_devices")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", deviceRowId)
    .then(() => {}, () => {});
}
