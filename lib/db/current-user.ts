// Resolves the app_users row for the currently logged-in Supabase Auth user.
//
// The identity (auth.uid()) comes from the cookie-bound client's validated
// session — trustworthy. The role/city lookup then uses the SERVICE-ROLE admin
// client, which BYPASSES RLS. This is deliberate and safe: we only ever read
// the CURRENT user's OWN row (keyed by their validated auth_id), never anyone
// else's — so it's not an escalation. Critically, it makes role resolution
// immune to RLS problems on app_users (a policy bug/recursion can no longer
// lock everyone out or silently over-grant admin). Data access itself stays
// RLS-protected via the cookie client elsewhere.

import { createClient } from "../supabase/server";
import { createAdminClient } from "../supabase/admin";
import type { AppUser } from "./schema";

export async function getCurrentAppUser(): Promise<AppUser | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const admin = createAdminClient();
  const { data } = await admin
    .from("app_users")
    .select("*")
    .eq("auth_id", user.id)
    .maybeSingle();

  return (data as AppUser) ?? null;
}
