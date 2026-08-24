// POST /api/gate/enrol — register a PHONE at a gate.
//
// Enrols the terminal, not a person. Guards are created separately
// (/api/gate/guards) and sign in on any active device in their city, which is
// what makes cover and mid-shift handover ordinary instead of a data problem.
//
// The device token is returned EXACTLY ONCE and stored hashed: a lost phone is
// revoked and re-enrolled, never recovered.

import { randomUUID } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { hashToken, newDeviceToken } from "@/lib/gate/auth";
import { loadSite, siteCodeFor } from "@/lib/gate/config";
import { ensureBuckets } from "@/lib/gate/evidence";
import { CITIES, type City } from "@/lib/sample-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET — what this deployment can actually see.
 *
 * A page can be cached, a component can be stale, and a conditional can hide
 * the very thing meant to explain a failure. This is a plain URL that answers
 * the question directly, with nothing between the runtime and the reader.
 *
 * Booleans and a name only. The secret itself is never returned.
 */
export async function GET() {
  // NOT session-gated, deliberately, and confined to preview so it can never
  // answer on production. Requiring a session made the diagnostic useless for
  // the exact failure it exists to explain: it returned "forbidden" while the
  // dashboard worked, because a session cookie belongs to ONE hostname and a
  // Vercel project has several (the branch URL and a per-build URL). Debugging
  // the debugger is not a good use of anyone's evening.
  //
  // Nothing here is a secret: booleans, a commit hash, and hostnames that are
  // already visible in the address bar.
  if (process.env.VERCEL_ENV === "production") {
    return NextResponse.json({ error: "not available" }, { status: 404 });
  }
  const env = process.env.VERCEL_ENV ?? null;
  const secret = !!process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return NextResponse.json({
    vercelEnv: env,
    secretPresent: secret,
    systemVarsExposed: !!process.env.VERCEL_URL,
    deploymentUrl: process.env.VERCEL_URL ?? null,
    appUrl: process.env.NEXT_PUBLIC_APP_URL ?? null,
    gitCommit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    // The two conditions that decide whether a pairing link carries a bypass.
    bypassWillApply: env === "preview" && secret,
    verdict:
      env === null ? "System environment variables are not exposed to this deployment."
      : env !== "preview" ? `This deployment reports itself as "${env}", not preview.`
      : !secret ? "Protection Bypass secret is not attached to this deployment — redeploy after enabling it."
      : "Bypass will be added to pairing links.",
  });
}

/** POST is enrolment; this lists the phones and who has used them. */
export async function listDevices(city: string | null) {
  const admin = createAdminClient();
  let q = admin.from("gate_devices")
    .select("id,device_id,city,site_code,device_label,status,last_seen_at,created_at")
    .order("created_at", { ascending: false });
  if (city) q = q.eq("city", city);
  const { data } = await q;
  const devices = (data ?? []) as Record<string, unknown>[];

  // The sign-in history for these phones. Refusals included -- a run of wrong
  // PINs on one handset is the only signal anyone is trying phones that are
  // not theirs, and it is worthless if only successes are kept.
  const ids = devices.map((d) => d.device_id as string);
  const { data: signIns } = ids.length
    ? await admin.from("gate_sign_ins")
        .select("device_id,ok,reason,at,app_users!guard_id(name)")
        .in("device_id", ids).order("at", { ascending: false }).limit(200)
    : { data: [] };

  return devices.map((d) => ({
    id: d.id, deviceId: d.device_id, city: d.city, siteCode: d.site_code,
    label: d.device_label, status: d.status,
    lastSeenAt: d.last_seen_at, createdAt: d.created_at,
    signIns: ((signIns ?? []) as Record<string, unknown>[])
      .filter((x) => x.device_id === d.device_id)
      .slice(0, 20)
      .map((x) => ({
        guardName: (x.app_users as { name?: string })?.name ?? "—",
        ok: x.ok, reason: x.reason, at: x.at,
      })),
  }));
}

export async function POST(req: NextRequest) {
  const me = await getCurrentAppUser();
  if (!me || (me.role !== "admin" && me.role !== "manager")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { city?: string; deviceLabel?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 400 }); }

  const city = (body.city ?? me.city ?? "").trim().toUpperCase() as City;
  if (!CITIES.includes(city)) {
    return NextResponse.json({ error: "a valid city is required" }, { status: 400 });
  }
  if (me.role === "manager" && city !== me.city) {
    return NextResponse.json({ error: "you can only enrol devices in your own city" }, { status: 403 });
  }

  const admin = createAdminClient();
  const site = await loadSite(admin, city);
  const token = newDeviceToken();

  const { data, error } = await admin
    .from("gate_devices")
    .insert({
      city,
      site_code: site?.siteCode ?? siteCodeFor(city),
      device_id: randomUUID(),
      device_label: body.deviceLabel?.trim() || null,
      token_hash: hashToken(token),
      created_by: me.id,
    })
    .select("id, device_id").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await ensureBuckets(admin);

  // THE ORIGIN THE MANAGER IS ACTUALLY LOOKING AT, not a hand-typed setting.
  //
  // NEXT_PUBLIC_APP_URL on production was "http://localhost:3000", so the link
  // handed to a guard's phone pointed at the manager's own laptop. lib/email
  // already hit this and wrote isPublicOrigin() to defend against it; the same
  // discipline belongs here, except a pairing link can do better than a
  // fallback — the request itself carries the right answer.
  //
  // Deriving it also means a preview produces a preview link and production
  // produces a production link, with nothing to configure and nothing to keep
  // in step.
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "");
  const base =
    host ? `${proto}://${host}`
    // Only if the request somehow carries no host: an explicitly public
    // override, never a localhost one.
    : configured && /^https:\/\//.test(configured) && !/localhost|127\.|192\.168\./.test(configured)
      ? configured
      : "";

  // VERCEL DEPLOYMENT PROTECTION. On Hobby, preview deployments sit behind a
  // Vercel login that cannot be switched off -- so a guard's phone, which has
  // no Vercel account, is bounced to an SSO page and reports "cannot connect
  // to the server". The app is fine; nothing ever reaches it.
  //
  // The bypass secret carried on the pairing link fixes it once per phone:
  // x-vercel-set-bypass-cookie leaves a cookie behind, so every later request
  // from that device -- including the sync API -- passes without the parameter.
  // Pairing is already a one-time act, which is exactly where this belongs.
  //
  // SCOPED TO PREVIEW DEPLOYMENTS ONLY, and that restriction is the important
  // half. The bypass secret is a PROJECT-level credential: Vercel injects it
  // into every deployment once the feature is switched on, production
  // included. Appending it wherever it happens to exist would put a secret
  // that unlocks protected deployments into production pairing links that have
  // no need of it -- links which then travel over WhatsApp to guards' phones.
  //
  // VERCEL_ENV is "production" | "preview" | "development", so a production
  // link is built exactly as it was before this existed.
  const bypass =
    process.env.VERCEL_ENV === "preview"
      ? process.env.VERCEL_AUTOMATION_BYPASS_SECRET
      : undefined;
  const q = new URLSearchParams({ t: token });
  if (bypass) {
    q.set("x-vercel-protection-bypass", bypass);
    q.set("x-vercel-set-bypass-cookie", "samesitenone");
  }

  return NextResponse.json({
    ok: true,
    // Diagnostic, and deliberately booleans and a name -- never the secret.
    // Whether the bypass applies depends on two things Vercel controls and the
    // app cannot see from outside: which environment this deployment thinks it
    // is, and whether the secret was injected at all (it is only attached to
    // deployments created AFTER Protection Bypass is switched on). Reporting
    // both turns "the link is short" into an answerable question.
    protectionBypass: !!bypass,
    diagnostics: {
      vercelEnv: process.env.VERCEL_ENV ?? "(not set)",
      secretPresent: !!process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
      systemVarsExposed: !!process.env.VERCEL_URL,
    },
    deviceRowId: data.id,
    deviceId: data.device_id,
    // SHOWN ONCE.
    deviceToken: token,
    // Hand this to the guard's phone; opening it once pairs the device.
    pairingUrl: `${base}/scan/pair?${q.toString()}`,
    site: site && { code: site.siteCode, label: site.label, lat: site.lat, lng: site.lng, radiusM: site.radiusM },
  });
}
