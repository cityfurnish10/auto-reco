// Browser-side Supabase client — uses the anon key, respects RLS.
// Used by React components and client-side data fetching.
//
// IMPORTANT: must use createBrowserClient from @supabase/ssr (not plain
// @supabase/supabase-js). The plain client stores the session in
// localStorage only; middleware.ts and lib/supabase/server.ts read the
// session from cookies via @supabase/ssr's createServerClient. Using the
// plain client here meant a successful sign-in never wrote a cookie, so
// middleware always saw "no session" and bounced every login straight back
// to /login regardless of credentials — createBrowserClient keeps the two
// in sync by writing the session to cookies as well as localStorage.

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing Supabase env vars: NEXT_PUBLIC_SUPABASE_URL and/or NEXT_PUBLIC_SUPABASE_ANON_KEY"
    );
  }

  _client = createBrowserClient(url, key);
  return _client;
}
