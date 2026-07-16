// Admin-only user management — update + delete a single app_users row.
// PATCH  /api/users/[id] {name?,role?,city?,status?} → reassign warehouse /
//   change role / activate-deactivate.
// DELETE /api/users/[id] → remove the Supabase Auth account + app_users row.
//
// Guards: an admin can't lock themselves out or remove the last active admin.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { CITIES } from "@/lib/sample-data";
import type { AppUser } from "@/lib/db/schema";

export const runtime = "nodejs";

const VALID_CITIES = new Set<string>(CITIES);

async function activeAdminCount(admin: ReturnType<typeof createAdminClient>) {
  const { count } = await admin
    .from("app_users")
    .select("id", { count: "exact", head: true })
    .eq("role", "admin")
    .eq("status", "active");
  return count ?? 0;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const me = await getCurrentAppUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  let body: { name?: string; role?: string; city?: string; status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: target } = await admin.from("app_users").select("*").eq("id", id).maybeSingle();
  if (!target) return NextResponse.json({ error: "user not found" }, { status: 404 });
  const t = target as AppUser;

  const update: Record<string, unknown> = {};
  if (body.name !== undefined) update.name = body.name.trim();

  let nextRole = t.role;
  if (body.role !== undefined) {
    nextRole = body.role === "admin" ? "admin" : "manager";
    update.role = nextRole;
    if (nextRole === "admin") update.city = null; // admins have no single city
  }
  if (nextRole === "manager" && body.city !== undefined) {
    const city = body.city.trim().toUpperCase();
    if (!VALID_CITIES.has(city))
      return NextResponse.json({ error: "invalid city" }, { status: 400 });
    update.city = city;
  }
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "inactive")
      return NextResponse.json({ error: "invalid status" }, { status: 400 });
    update.status = body.status;
  }

  // Don't let the last active admin be demoted / deactivated, and don't let an
  // admin lock themselves out of admin.
  const losingAdmin =
    (t.role === "admin" && t.status === "active") &&
    (update.role === "manager" || update.status === "inactive");
  if (losingAdmin) {
    if (t.id === me.id)
      return NextResponse.json({ error: "you can't remove your own admin access" }, { status: 400 });
    if ((await activeAdminCount(admin)) <= 1)
      return NextResponse.json({ error: "can't remove the last active admin" }, { status: 400 });
  }

  if (Object.keys(update).length === 0)
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });

  const { data, error } = await admin
    .from("app_users")
    .update(update)
    .eq("id", id)
    .select("id, auth_id, email, name, role, city, status, created_at, updated_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const me = await getCurrentAppUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  const admin = createAdminClient();
  const { data: target } = await admin.from("app_users").select("*").eq("id", id).maybeSingle();
  if (!target) return NextResponse.json({ error: "user not found" }, { status: 404 });
  const t = target as AppUser;

  if (t.id === me.id)
    return NextResponse.json({ error: "you can't delete your own account" }, { status: 400 });
  if (t.role === "admin" && t.status === "active" && (await activeAdminCount(admin)) <= 1)
    return NextResponse.json({ error: "can't delete the last active admin" }, { status: 400 });

  // Remove the app_users row first, then the auth account.
  const { error: rowErr } = await admin.from("app_users").delete().eq("id", id);
  if (rowErr) return NextResponse.json({ error: rowErr.message }, { status: 500 });
  if (t.auth_id) await admin.auth.admin.deleteUser(t.auth_id).catch(() => {});

  return NextResponse.json({ ok: true });
}
