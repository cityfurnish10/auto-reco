// Admin-only user management — list + create.
// GET  /api/users            → list app_users
// POST /api/users {email,name,role,city,password} → create a real Supabase Auth
//   account + its app_users row (admin sets the initial password).
//
// Authorization: the caller must be an admin (getCurrentAppUser resolves the
// role via the service-role client, so it works regardless of RLS). All DB /
// Auth writes use the service-role admin client — never the browser.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { CITIES } from "@/lib/sample-data";

export const runtime = "nodejs";

const VALID_CITIES = new Set<string>(CITIES);

async function requireAdmin() {
  const me = await getCurrentAppUser();
  if (!me || me.role !== "admin") return null;
  return me;
}

export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("app_users")
    .select("id, auth_id, email, name, role, city, status, created_at, updated_at")
    .order("role", { ascending: true })
    .order("city", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { email?: string; name?: string; role?: string; city?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  const name = body.name?.trim();
  const role = body.role === "admin" ? "admin" : "manager";
  const city = role === "admin" ? null : body.city?.trim().toUpperCase() ?? null;
  const password = body.password ?? "";

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return NextResponse.json({ error: "a valid email is required" }, { status: 400 });
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (password.length < 8)
    return NextResponse.json({ error: "password must be at least 8 characters" }, { status: 400 });
  if (role === "manager" && (!city || !VALID_CITIES.has(city)))
    return NextResponse.json({ error: "a manager needs a valid city" }, { status: 400 });

  const admin = createAdminClient();

  // 1. Create the Supabase Auth user (email_confirm so they can log in now — no SMTP needed).
  const { data: created, error: authErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (authErr || !created?.user) {
    return NextResponse.json(
      { error: authErr?.message ?? "could not create the auth account" },
      { status: 400 }
    );
  }

  // 2. Insert the app_users row linked by auth_id.
  const { data: row, error: rowErr } = await admin
    .from("app_users")
    .insert({ auth_id: created.user.id, email, name, role, city, status: "active" })
    .select("id, auth_id, email, name, role, city, status, created_at, updated_at")
    .single();

  // 3. Roll back the auth user if the row insert failed (no orphaned accounts).
  if (rowErr) {
    await admin.auth.admin.deleteUser(created.user.id).catch(() => {});
    const conflict = rowErr.code === "23505"; // unique_violation (email already exists)
    return NextResponse.json(
      { error: conflict ? "a user with that email already exists" : rowErr.message },
      { status: conflict ? 409 : 500 }
    );
  }

  return NextResponse.json({ data: row }, { status: 201 });
}
