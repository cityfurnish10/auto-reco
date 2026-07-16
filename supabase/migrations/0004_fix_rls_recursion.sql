-- =============================================================================
-- 0004_fix_rls_recursion.sql — fix "infinite recursion detected in policy for
-- relation app_users" and make role/city scoping actually work.
--
-- ROOT CAUSE: the 0001/0003 policies decided admin/city by running
--   EXISTS (SELECT 1 FROM app_users u WHERE u.auth_id = auth.uid() AND ...)
-- inside the policies — INCLUDING inside app_users' own SELECT policy. Reading
-- app_users then re-evaluates app_users' policy, which reads app_users again →
-- infinite recursion. Postgres aborts every app_users-dependent query
-- (variances, guard_uploads, and app_users itself), so getCurrentAppUser()
-- threw, the app fell back to "admin", and every user saw all cities.
--
-- FIX: read the caller's role/city through SECURITY DEFINER helper functions.
-- They run as the function owner (the table owner), which bypasses RLS, so
-- they can read app_users without triggering its policy — no recursion. Every
-- policy then calls the helpers instead of a self-referential subquery.
-- =============================================================================

-- 1. Helpers — SECURITY DEFINER so they bypass RLS (no recursion).
create or replace function public.auth_is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.app_users
    where auth_id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.auth_city()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select city from public.app_users where auth_id = auth.uid() limit 1;
$$;

grant execute on function public.auth_is_admin() to authenticated, anon;
grant execute on function public.auth_city() to authenticated, anon;

-- 2. Rewrite every policy that self-referenced app_users.

-- app_users: a user reads their OWN row (no recursion); admins read all.
drop policy if exists app_users_select on app_users;
create policy app_users_select on app_users
  for select using (auth.uid() = auth_id or public.auth_is_admin());

-- source_rows: admin all; manager their city.
drop policy if exists source_rows_select on source_rows;
create policy source_rows_select on source_rows
  for select using (public.auth_is_admin() or city = public.auth_city());

-- variances: admin all; manager their city.
drop policy if exists variances_select on variances;
create policy variances_select on variances
  for select using (public.auth_is_admin() or city = public.auth_city());

-- variances: manager can close/dispute their OWN city's variances (updates the
-- shared table, so the admin dashboard sees the change immediately).
drop policy if exists variances_update on variances;
create policy variances_update on variances
  for update
  using (public.auth_is_admin() or city = public.auth_city())
  with check (public.auth_is_admin() or city = public.auth_city());

-- guard_uploads: admin all; manager their city (read + insert + review-update).
drop policy if exists guard_uploads_select on guard_uploads;
create policy guard_uploads_select on guard_uploads
  for select using (public.auth_is_admin() or city = public.auth_city());

drop policy if exists guard_uploads_insert on guard_uploads;
create policy guard_uploads_insert on guard_uploads
  for insert with check (public.auth_is_admin() or city = public.auth_city());

drop policy if exists guard_uploads_update on guard_uploads;
create policy guard_uploads_update on guard_uploads
  for update
  using (public.auth_is_admin() or city = public.auth_city())
  with check (public.auth_is_admin() or city = public.auth_city());

-- storage.objects (guard-registers bucket) — city = first path segment
-- {CITY}/{business_date}/{upload_id}.pdf. Managers only touch their city's folder.
drop policy if exists guard_registers_insert on storage.objects;
create policy guard_registers_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'guard-registers'
    and (public.auth_is_admin() or (storage.foldername(name))[1] = public.auth_city())
  );

drop policy if exists guard_registers_select on storage.objects;
create policy guard_registers_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'guard-registers'
    and (public.auth_is_admin() or (storage.foldername(name))[1] = public.auth_city())
  );
