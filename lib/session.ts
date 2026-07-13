// Server-side session resolution. Pages call getSessionUser() and stay
// agnostic to the auth backend: demo cookie today, Supabase Auth + app_users
// once the central DB is provided.

import { cookies } from "next/headers";
import { SESSION_COOKIE, parseSessionCookie, type SessionUser } from "./demo-auth";
import { createClient } from "./supabase/server";

export const supabaseConfigured =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
  !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export async function getSessionUser(): Promise<SessionUser | null> {
  if (!supabaseConfigured) {
    return parseSessionCookie((await cookies()).get(SESSION_COOKIE)?.value);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // Until app_users exists in Supabase, authenticated users get admin scope.
  return {
    name: user.email ?? "User",
    email: user.email ?? "",
    role: "ADMIN",
    city: null,
  };
}
