-- 0009_approval_email_scheduling.sql
-- Three features in one migration:
--  A) Variance submit-for-approval workflow — a city manager SUBMITS a variance
--     for approval (status 'pending_approval') instead of closing it directly;
--     an admin then approves it (-> closed) or rejects it (-> open). Adds the
--     new status value + submitter/rejection audit columns.
--  B) Email multi-recipient + notes audit — cc/bcc/notes/sent_by on email_logs,
--     plus a 'scheduled' kind for deferred digests.
--  C) Deferred/scheduled digest send — a scheduled_emails queue drained by the
--     existing daily email-digest cron (no new cron; Vercel Hobby 2-cron cap).

-- ── A) variances: approval workflow ─────────────────────────────────────────
-- Extend the status CHECK to allow 'pending_approval' (drop + re-add, per 0006).
alter table public.variances drop constraint if exists variances_status_check;
alter table public.variances
  add constraint variances_status_check
  check (status in ('open', 'in_progress', 'pending_approval', 'closed'));

alter table public.variances
  add column if not exists submitted_by   uuid references public.app_users(id),
  add column if not exists submitted_at   timestamptz,
  add column if not exists submit_reason  text,
  add column if not exists submit_note    text,
  add column if not exists rejection_note text;

-- ── B) email_logs: cc / bcc / notes / sender + 'scheduled' kind ──────────────
alter table public.email_logs
  add column if not exists cc      text[] not null default '{}',
  add column if not exists bcc     text[] not null default '{}',
  add column if not exists notes   text,
  add column if not exists sent_by uuid references public.app_users(id);

alter table public.email_logs drop constraint if exists email_logs_kind_check;
alter table public.email_logs
  add constraint email_logs_kind_check check (kind in ('digest', 'test', 'scheduled'));

-- ── C) scheduled_emails: deferred digest queue ──────────────────────────────
-- The daily email-digest cron sweeps this table for due, still-pending rows and
-- sends them. The digest is ALWAYS re-derived from the DB by business_date at
-- send time, so a deferred email reflects the latest closure state (that is the
-- whole point of "send once variances are resolved, 1-2 days later").
create table if not exists public.scheduled_emails (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null default 'digest' check (kind in ('digest')),
  business_date    date not null,                  -- reconcile day this digest covers
  send_at          timestamptz not null,           -- earliest time it may go out
  status           text not null default 'pending'
                   check (status in ('pending', 'sending', 'sent', 'skipped', 'canceled', 'failed')),
  require_resolved boolean not null default true,   -- gate: only send once all REAL variances are closed
  recipients       text[] not null default '{}',    -- 'to' override; empty = DIGEST_RECIPIENTS
  cc               text[] not null default '{}',
  bcc              text[] not null default '{}',
  notes            text,
  attempts         int not null default 0,
  last_error       text,
  scheduled_by     uuid references public.app_users(id),
  email_log_id     uuid references public.email_logs(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_sched_due on public.scheduled_emails (status, send_at);

alter table public.scheduled_emails enable row level security;

-- Admins may read the queue; all writes go through the service-role client
-- (schedule route + cron), which bypasses RLS — no authenticated write policy.
drop policy if exists scheduled_emails_select on public.scheduled_emails;
create policy scheduled_emails_select on public.scheduled_emails
  for select using (public.auth_is_admin());

drop trigger if exists trg_scheduled_emails_updated_at on public.scheduled_emails;
create trigger trg_scheduled_emails_updated_at
  before update on public.scheduled_emails
  for each row execute function public.set_updated_at();
