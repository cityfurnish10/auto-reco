-- 0005_run_city_stats.sql
-- Per-city rollup written once per reconciliation run, so the leaderboard can
-- rank cities by accuracy rate (REAL variances / total movements) across time
-- windows (latest / 7d / 30d / overall) WITHOUT needing source_rows (which are
-- pruned after 7 days) or the global reconciliation_runs aggregates.
--
-- Upsert on (business_date, city): a re-run of a date overwrites that date's
-- row, so window sums never double-count re-runs — same idea as the variances
-- natural-key upsert.

create table if not exists public.run_city_stats (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid references public.reconciliation_runs(id) on delete cascade,
  business_date date not null,
  city          text not null check (city in ('DELHI','MUMBAI','PUNE','HYDRABAD','BANGALORE')),
  movements     int  not null default 0,  -- denominator: total distinct directional movements
  real_count    int  not null default 0,  -- numerator: REAL-bucket variances (as-found)
  info_count    int  not null default 0,
  high_count    int  not null default 0,
  created_at    timestamptz not null default now(),
  unique (business_date, city)
);

create index if not exists idx_rcs_date_city on public.run_city_stats (business_date, city);

-- RLS: same predicate as variances (admin sees all; a manager sees own city).
-- The leaderboard API reads via the service-role client to show all cities to
-- everyone, but keep RLS restrictive for any direct client access.
alter table public.run_city_stats enable row level security;

drop policy if exists run_city_stats_select on public.run_city_stats;
create policy run_city_stats_select on public.run_city_stats
  for select
  using (public.auth_is_admin() or city = public.auth_city());
