-- =============================================================================
-- 0002_seed_app_users.sql — link Supabase Auth accounts to the 6 pre-seeded
-- app_users rows (seeded directly by 0001_init.sql, step 10 — no auth.users
-- dependency needed for the rows to exist).
--
-- This migration's job is just to set app_users.auth_id once you've created
-- matching Supabase Auth users (Authentication → Users) for these 6 emails —
-- that's what makes `auth.uid()` resolve to the right row for RLS.
--
-- Safe to run repeatedly (idempotent UPDATE by email match; no-op for emails
-- that don't have a matching auth.users row yet).
-- =============================================================================
update public.app_users a
set auth_id    = u.id,
    updated_at = now()
from auth.users u
where lower(u.email) = lower(a.email)
  and a.auth_id is distinct from u.id;
