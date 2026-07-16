-- 0007_email_logs.sql
-- Audit log of digest email sends, for the System Health activity timeline.
-- (ingestion_logs can't be reused — its source CHECK only allows the 4 data
-- connectors.) One row per send attempt: nightly digest (kind='digest', tied to
-- a run) or an admin test send (kind='test', run_id null).

create table if not exists public.email_logs (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid references public.reconciliation_runs(id) on delete set null,
  kind          text not null check (kind in ('digest','test')),
  business_date date,                       -- the reconcile date the digest covered
  status        text not null check (status in ('sent','skipped','failed')),
  recipients    text[] not null default '{}',
  message_id    text,
  error         text,                       -- skip reason or failure message
  created_at    timestamptz not null default now()
);

create index if not exists idx_email_logs_created on public.email_logs (created_at desc);

-- Admin-only read (System Health is admin-only). Writes go through the
-- service-role client, which bypasses RLS.
alter table public.email_logs enable row level security;

drop policy if exists email_logs_select on public.email_logs;
create policy email_logs_select on public.email_logs
  for select using (public.auth_is_admin());
