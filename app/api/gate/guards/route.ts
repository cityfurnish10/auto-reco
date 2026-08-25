// Guard profiles — the people, as distinct from the phones.
//
//   GET  — list this city's guards (supervisor view)
//   POST — create a guard and their sign-in
//
// A guard is an app_users row with role 'guard' plus a guard_profiles row
// holding their own PIN and reference photo. Reusing app_users is what keeps
// row-level security, city scoping and user management working for the new
// role instead of growing a parallel identity system beside them.

import { randomUUID } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { hashPin } from "@/lib/gate/auth";
import { ATTENDANCE_BUCKET, ensureBuckets, signPhotoRead } from "@/lib/gate/evidence";
import { CITIES, type City } from "@/lib/sample-data";
import { isRealDescriptor } from "@/lib/gate/descriptor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function supervisor() {
  const me = await getCurrentAppUser();
  if (!me || (me.role !== "admin" && me.role !== "manager")) return null;
  return me;
}

export async function GET(req: NextRequest) {
  const me = await supervisor();
  if (!me) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const admin = createAdminClient();
  const city = (req.nextUrl.searchParams.get("city") ?? me.city ?? "").toUpperCase();
  let q = admin
    .from("guard_profiles")
    .select("id,guard_id,city,employee_code,phone,status,reference_photo,consent_at,created_at,app_users!guard_id!inner(name)")
    .order("created_at", { ascending: true });
  // An admin may look at any city; a manager only ever their own.
  if (me.role === "manager") q = q.eq("city", me.city ?? "");
  else if (city) q = q.eq("city", city);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const guards = await Promise.all(
    ((data ?? []) as Record<string, unknown>[]).map(async (r) => ({
      id: r.id,
      guardId: r.guard_id,
      name: (r.app_users as { name?: string })?.name ?? "",
      city: r.city,
      employeeCode: r.employee_code,
      phone: r.phone,
      status: r.status,
      hasReferencePhoto: !!r.reference_photo,
      consentAt: r.consent_at,
      referencePhotoUrl: r.reference_photo
        ? await signPhotoRead(admin, ATTENDANCE_BUCKET, r.reference_photo as string, 1800)
        : null,
    }))
  );
  return NextResponse.json({ guards });
}

/** PATCH — retake a guard's reference photo, or deactivate them. */
export async function PATCH(req: NextRequest) {
  const me = await supervisor();
  if (!me) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: { guardId?: string; descriptor?: number[]; status?: "active" | "inactive";
              pin?: string; referencePhotoFailed?: boolean };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 400 }); }
  if (!body.guardId) return NextResponse.json({ error: "guardId is required" }, { status: 400 });

  const admin = createAdminClient();
  const { data: prof } = await admin
    .from("guard_profiles").select("id,city").eq("guard_id", body.guardId).maybeSingle();
  if (!prof) return NextResponse.json({ error: "no such guard" }, { status: 404 });
  if (me.role === "manager" && prof.city !== me.city) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (Array.isArray(body.descriptor) && body.descriptor.length) {
    // A vector of 128 zeros is what face-api hands back for a frame that never
    // arrived, and it is indistinguishable from a real one by length alone.
    // Stored, it becomes a reference no living face can match and the guard is
    // refused every morning. Refused here, the manager simply retakes.
    if (!isRealDescriptor(body.descriptor as number[])) {
      return NextResponse.json(
        { error: "That photo did not produce a usable face signature. Please retake it." },
        { status: 400 }
      );
    }
    update.reference_descriptor = body.descriptor;
    update.consent_at = new Date().toISOString();
  }
  // The browser telling us its upload did not land. The profile row is written
  // with reference_photo BEFORE the bytes are sent — the upload happens from
  // the manager's browser, after this route has already answered — so without
  // this the row claims a photograph that does not exist, and nothing
  // downstream can tell the difference.
  if (body.referencePhotoFailed) update.reference_photo = null;
  if (body.status) update.status = body.status;
  if (body.pin) {
    if (!/^\d{4,6}$/.test(body.pin)) {
      return NextResponse.json({ error: "PIN must be 4 to 6 digits" }, { status: 400 });
    }
    update.pin_hash = hashPin(body.pin);
  }

  const { error } = await admin.from("guard_profiles").update(update).eq("id", prof.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // A fresh upload link so the photo behind the descriptor can be replaced too.
  const bucketProblems = await ensureBuckets(admin);
  const path = `reference/${body.guardId}.jpg`;
  const { data: up, error: upErr } = await admin.storage
    .from(ATTENDANCE_BUCKET).createSignedUploadUrl(path);
  return NextResponse.json({
    ok: true,
    referencePhotoUpload: up ? { bucket: ATTENDANCE_BUCKET, path, token: up.token } : null,
    // Handed back so a manager sees the REASON rather than a photo that
    // quietly never appears.
    photoProblem: up ? null
      : [upErr?.message, ...bucketProblems].filter(Boolean).join("; ") || "storage refused an upload link",
  });
}

export async function POST(req: NextRequest) {
  const me = await supervisor();
  if (!me) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: { name?: string; city?: string; pin?: string; employeeCode?: string;
              phone?: string; descriptor?: number[]; confirmDuplicateName?: boolean };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 400 }); }

  const name = body.name?.trim();
  const city = (body.city ?? me.city ?? "").trim().toUpperCase() as City;
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (!CITIES.includes(city)) return NextResponse.json({ error: "a valid city is required" }, { status: 400 });
  if (me.role === "manager" && city !== me.city) {
    return NextResponse.json({ error: "you can only add guards in your own city" }, { status: 403 });
  }
  // Four to six digits is what a gate can use one-handed. The PIN stops a
  // passer-by picking up an unattended phone; the check-in selfie is what
  // actually proves who is on duty.
  if (!/^\d{4,6}$/.test(body.pin ?? "")) {
    return NextResponse.json({ error: "PIN must be 4 to 6 digits" }, { status: 400 });
  }

  const admin = createAdminClient();

  // SAME NAME, SAME CITY. Not blocked outright -- two people really can share a
  // name, and a hard rule would eventually stop a genuine hire with no way
  // round it. Refused once, with the existing guard named, and allowed if the
  // operator confirms they mean it. Codes and phone numbers ARE hard-blocked,
  // by unique indexes in 0025, because those identify a person.
  if (!body.confirmDuplicateName) {
    const { data: sameName } = await admin
      .from("guard_profiles")
      .select("guard_id, employee_code, app_users!guard_id!inner(name)")
      .eq("city", city)
      .eq("status", "active");
    const clash = ((sameName ?? []) as Record<string, unknown>[]).find(
      (r) => ((r.app_users as { name?: string })?.name ?? "").trim().toLowerCase()
             === name.toLowerCase()
    );
    if (clash) {
      return NextResponse.json({
        error: `${name} is already a guard at ${city}` +
               (clash.employee_code ? ` (code ${clash.employee_code})` : "") + ".",
        duplicateName: true,
      }, { status: 409 });
    }
  }

  // Synthetic address: guards sign in by name and PIN on an enrolled phone and
  // never touch email. It exists only because app_users requires a unique one.
  const email = `guard.${randomUUID().slice(0, 8)}@gate.cityfurnish.local`;

  const { data: user, error: uErr } = await admin
    .from("app_users")
    .insert({ email, name, role: "guard", city, status: "active" })
    .select("id").single();
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 400 });

  const { data: prof, error: pErr } = await admin
    .from("guard_profiles")
    .insert({
      guard_id: user.id,
      city,
      pin_hash: hashPin(body.pin!),
      employee_code: body.employeeCode?.trim() || null,
      phone: body.phone?.trim() || null,
      consent_at: new Date().toISOString(),
      // Computed in the manager's browser from the photo they just took. Null
      // until then, which the roster reports as `enrolled: false` so a guard
      // with no signature is visible rather than silently unverifiable.
      // Same rule as the update path above. NULL rather than a bad vector when
      // it fails: the roster reports that as `enrolled: false`, so a guard with
      // no signature is visible instead of silently unverifiable.
      reference_descriptor: isRealDescriptor(body.descriptor as number[])
        ? body.descriptor : null,
      created_by: me.id,
    })
    .select("id").single();
  if (pErr) {
    // Do not leave a guard account with no way to sign in.
    await admin.from("app_users").delete().eq("id", user.id);
    // 23505 is a unique index from 0025. The raw message names an index, which
    // means nothing to the person at the screen.
    const friendly =
      pErr.code === "23505"
        ? /employee_code/.test(pErr.message)
          ? `Employee code ${body.employeeCode} is already used by another guard at ${city}.`
          : /phone/.test(pErr.message)
            ? `That phone number is already registered to another guard.`
            : "A guard with those details already exists."
        : pErr.message;
    return NextResponse.json({ error: friendly }, { status: 400 });
  }

  const bucketProblems = await ensureBuckets(admin);
  const path = `reference/${user.id}.jpg`;
  const { data: up, error: upErr } = await admin.storage
    .from(ATTENDANCE_BUCKET).createSignedUploadUrl(path);
  // Recorded ONLY when there is a link to upload with. Setting it regardless
  // made the row claim a photograph that the browser might never manage to
  // send, and nothing downstream could tell the two apart.
  if (up) {
    await admin.from("guard_profiles").update({ reference_photo: path }).eq("id", prof.id);
  }

  return NextResponse.json({
    ok: true,
    guardId: user.id,
    profileId: prof.id,
    name, city,
    referencePhotoUpload: up ? { bucket: ATTENDANCE_BUCKET, path, token: up.token } : null,
    // Handed back so a manager sees the REASON rather than a photo that
    // quietly never appears.
    photoProblem: up ? null
      : [upErr?.message, ...bucketProblems].filter(Boolean).join("; ") || "storage refused an upload link",
  });
}
