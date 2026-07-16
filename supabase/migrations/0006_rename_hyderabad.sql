-- 0006_rename_hyderabad.sql
-- Corrects the misspelled city value 'HYDRABAD' -> 'HYDERABAD' everywhere it is
-- a DB-constrained value: app_users, source_rows, variances, guard_uploads,
-- run_city_stats. For each table we drop the existing city CHECK (name-agnostic,
-- via pg_constraint lookup), rewrite the data, then re-add the corrected CHECK.
-- Also fixes guard-register Storage paths recorded in guard_uploads.file_path.
--
-- The manager login email (hydrabad.manager@cityfurnish.com) is intentionally
-- left unchanged. auth_city()/auth_is_admin() need no edit — they return
-- app_users.city dynamically.
--
-- Deploy this together with the matching code (which now writes 'HYDERABAD').

-- app_users --------------------------------------------------------------
do $$ declare c text; begin
  for c in select conname from pg_constraint
    where conrelid = 'public.app_users'::regclass and contype='c'
      and pg_get_constraintdef(oid) ilike '%HYDRABAD%'
  loop execute format('alter table public.app_users drop constraint %I', c); end loop;
end $$;
update public.app_users set city='HYDERABAD' where city='HYDRABAD';
alter table public.app_users
  add constraint app_users_city_check
  check (city is null or city in ('DELHI','MUMBAI','PUNE','HYDERABAD','BANGALORE'));

-- source_rows ------------------------------------------------------------
do $$ declare c text; begin
  for c in select conname from pg_constraint
    where conrelid = 'public.source_rows'::regclass and contype='c'
      and pg_get_constraintdef(oid) ilike '%HYDRABAD%'
  loop execute format('alter table public.source_rows drop constraint %I', c); end loop;
end $$;
update public.source_rows set city='HYDERABAD' where city='HYDRABAD';
alter table public.source_rows
  add constraint source_rows_city_check
  check (city in ('DELHI','MUMBAI','PUNE','HYDERABAD','BANGALORE'));

-- variances --------------------------------------------------------------
do $$ declare c text; begin
  for c in select conname from pg_constraint
    where conrelid = 'public.variances'::regclass and contype='c'
      and pg_get_constraintdef(oid) ilike '%HYDRABAD%'
  loop execute format('alter table public.variances drop constraint %I', c); end loop;
end $$;
update public.variances set city='HYDERABAD' where city='HYDRABAD';
alter table public.variances
  add constraint variances_city_check
  check (city in ('DELHI','MUMBAI','PUNE','HYDERABAD','BANGALORE'));

-- guard_uploads ----------------------------------------------------------
do $$ declare c text; begin
  for c in select conname from pg_constraint
    where conrelid = 'public.guard_uploads'::regclass and contype='c'
      and pg_get_constraintdef(oid) ilike '%HYDRABAD%'
  loop execute format('alter table public.guard_uploads drop constraint %I', c); end loop;
end $$;
update public.guard_uploads set city='HYDERABAD' where city='HYDRABAD';
alter table public.guard_uploads
  add constraint guard_uploads_city_check
  check (city in ('DELHI','MUMBAI','PUNE','HYDERABAD','BANGALORE'));
-- Storage folder segment (guard-registers/{CITY}/...) recorded in file_path.
update public.guard_uploads
  set file_path = 'HYDERABAD/' || substr(file_path, length('HYDRABAD/') + 1)
  where file_path like 'HYDRABAD/%';

-- run_city_stats ---------------------------------------------------------
do $$ declare c text; begin
  for c in select conname from pg_constraint
    where conrelid = 'public.run_city_stats'::regclass and contype='c'
      and pg_get_constraintdef(oid) ilike '%HYDRABAD%'
  loop execute format('alter table public.run_city_stats drop constraint %I', c); end loop;
end $$;
update public.run_city_stats set city='HYDERABAD' where city='HYDRABAD';
alter table public.run_city_stats
  add constraint run_city_stats_city_check
  check (city in ('DELHI','MUMBAI','PUNE','HYDERABAD','BANGALORE'));
