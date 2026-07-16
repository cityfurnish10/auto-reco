// Server-side session resolution. Pages call getSessionUser() and stay
// agnostic to the auth backend: demo cookie when Supabase isn't configured,
// Supabase Auth + app_users (real role + city, RLS-scoped) when it is.

import { cookies } from "next/headers";
import { SESSION_COOKIE, parseSessionCookie, type SessionUser } from "./demo-auth";
import { createClient } from "./supabase/server";
import { getCurrentAppUser } from "./db/current-user";

export const supabaseConfigured =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
  !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export async function getSessionUser(): Promise<SessionUser | null> {
  if (!supabaseConfigured) {
    return parseSessionCookie((await cookies()).get(SESSION_COOKIE)?.value);
  }

  // Real role + city from app_users (admin → ADMIN sees all cities; manager /
  // viewer → MANAGER scoped to their own city). RLS enforces write
  // authorization regardless of what the UI shows.
  const appUser = await getCurrentAppUser();
  if (appUser) {
    return {
      name: appUser.name,
      email: appUser.email,
      role: appUser.role === "admin" ? "ADMIN" : "MANAGER",
      city: appUser.city,
    };
  }

  // Authenticated but no app_users row (unprovisioned, or the app_users lookup
  // errored). FAIL CLOSED — never grant admin here. Return a MANAGER with no
  // city: they land on the (empty, city-scoped) manager view and RLS returns
  // nothing, rather than getting all-cities admin access. An admin must
  // provision them in app_users to give real access.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return {
    name: user.email ?? "User",
    email: user.email ?? "",
    role: "MANAGER",
    city: null,
  };
}
