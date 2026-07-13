import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Service-role client — bypasses RLS. Server-side only (ingestion, engine,
// cron). Importing this in client code is a security bug.
export function createAdminClient() {
  if (typeof window !== "undefined") {
    throw new Error("Admin client must never be used in the browser");
  }
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}
