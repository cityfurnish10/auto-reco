// Resolves the app_users row for the currently logged-in Supabase Auth user.
// Uses the cookie-bound server client (lib/supabase/server.ts) so the lookup
// itself is RLS-scoped — a user can only ever read their own app_users row
// this way (see the app_users_select policy), which is exactly what's needed.

import { createClient } from "../supabase/server";
import type { AppUser } from "./schema";

export async function getCurrentAppUser(): Promise<AppUser | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("app_users")
    .select("*")
    .eq("auth_id", user.id)
    .single();

  return (data as AppUser) ?? null;
}
