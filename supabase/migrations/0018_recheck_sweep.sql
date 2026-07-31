-- Re-check the whole ageing window every afternoon, from Postgres.
--
-- WHY: the digest's third section reports errors still open more than two days,
-- over a seven-day lookback. That claim is only true if those seven days have
-- actually been RE-RUN, because resolveStaleOpenVariances -- the thing that
-- notices an item cleared -- only executes when a date is reconciled again.
--
-- Today exactly ONE old date is re-run per day: the reconcile cron's second
-- pass targets recheckTargetDate = D-2 (lib/reconcile/cron-dates.ts:75-77). So
-- an item raised on D-7 was last looked at on D-4, and "still open for 9 days"
-- can just as easily mean "cleared four days ago and nobody re-ran the day to
-- find out". Reporting that to the founder is worse than reporting nothing.
--
-- WHY NOT ON VERCEL: a single reconcile pass is p50 36s / p90 53s against a 60s
-- Hobby function ceiling, which is why route.ts already guards its ONE extra
-- pass with RECHECK_BUDGET_MS = 40s. Six more passes is ~4 minutes; it does not
-- fit in one invocation, and Hobby caps the project at 2 cron jobs, both used.
--
-- So the schedule moves into the database. One HTTP call per date means each
-- date gets its own fresh 60s function budget, and pg_cron has no job cap.
--
-- SECONDARY BENEFIT, and not a small one: cron.job_run_details is a real
-- invocation history. Vercel Hobby keeps none, which is why two silent digest
-- no-shows (29 and 30 Jul 2026) could not be diagnosed at all -- there was no
-- way to tell "the platform never fired" from "the route threw before it could
-- write its audit row".
--
-- The two Vercel crons are deliberately left in place. This adds a sweep; it
-- does not migrate the primary reconcile or the digest. Run both for a week and
-- compare cron.job_run_details against email_logs before moving anything else.
--
-- PREREQUISITES, run once from the Supabase SQL editor (NOT committed here --
-- the second statement contains a secret):
--
--   create extension if not exists pg_cron;
--   create extension if not exists pg_net with schema extensions;
--   select vault.create_secret('<the CRON_SECRET value>', 'cron_secret',
--                              'Bearer token for /api/cron/* routes');
--
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- Helpers. Own schema so nothing lands in public and collides with app tables.
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS app_cron;

-- The deployment to call. A stable alias, never a per-deployment URL: those
-- rotate on every push and would leave the sweep pointing at a dead build.
CREATE OR REPLACE FUNCTION app_cron.base_url()
  RETURNS text LANGUAGE sql IMMUTABLE AS
$$ SELECT 'https://auto-reco.vercel.app' $$;

-- The bearer token, read from Vault at call time.
--
-- SECURITY DEFINER because pg_cron executes as the job owner, which has no
-- business holding vault read rights permanently. search_path is pinned: a
-- SECURITY DEFINER function with a mutable search_path is the classic
-- privilege-escalation shape.
CREATE OR REPLACE FUNCTION app_cron.secret()
  RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = vault, public AS
$$ SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1 $$;

REVOKE ALL ON FUNCTION app_cron.secret() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The sweep call.
-- ---------------------------------------------------------------------------

-- Re-reconcile the business date `offset_days` behind the one the digest will
-- report this afternoon.
--
-- THE DATE ARITHMETIC MUST MATCH lib/reconcile/cron-dates.ts. A business day
-- runs 15:00 -> 15:00 IST, so at any moment after 15:00 IST the day currently
-- OPEN is today's IST calendar date, and the last CLOSED one -- what the digest
-- reports, called D everywhere else -- is IST date - 1. This function is
-- therefore only correct when scheduled after 15:00 IST (09:30 UTC); the
-- schedule below runs at 15:50 IST. Moving it earlier silently shifts every
-- target by a day.
--
-- POST, not GET: the route treats an explicit ?date= as a targeted single pass
-- and skips its own second re-check (app/api/cron/reconcile/route.ts:64-71), so
-- these calls cannot recurse into one another.
--
-- skipOcr: a guard register still unprocessed days later has failed repeatedly,
-- and 10 uploads x 55s of Azure polling inside a 60s function is a tail risk
-- with no upside. Same reasoning route.ts:104-107 already applies to its D-2
-- pass. Skipping is fail-safe -- the guard source is then simply absent.
CREATE OR REPLACE FUNCTION app_cron.recheck(offset_days int)
  RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = extensions, public, app_cron AS
$$
  SELECT net.http_post(
    url := app_cron.base_url()
        || '/api/cron/reconcile?skipOcr=1&date='
        || to_char(((now() AT TIME ZONE 'Asia/Kolkata')::date - 1 - offset_days), 'YYYY-MM-DD'),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || app_cron.secret(),
      'Content-Type', 'application/json'
    ),
    -- pg_net defaults to FIVE SECONDS. Against routes that legitimately run to
    -- 60 that would mark every single call failed while the work succeeded.
    timeout_milliseconds := 60000
  );
$$;

REVOKE ALL ON FUNCTION app_cron.recheck(int) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The schedule: D-2 .. D-7, one per minute.
-- ---------------------------------------------------------------------------

-- 10:20-10:25 UTC = 15:50-15:55 IST. Both bounds matter:
--   * AFTER 15:00 IST, or the date arithmetic above is off by one.
--   * BEFORE 16:30 IST (11:00 UTC), so every swept date is settled before the
--     primary reconcile and, 15 minutes after it, the digest that reads them.
-- Spaced a minute apart so each call owns a whole function invocation rather
-- than six of them contending for the same instance.
DO $$
DECLARE
  k int;
  job text;
BEGIN
  -- cron.schedule raises if the extension is absent; say so usefully.
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION 'pg_cron is not installed. Run: create extension if not exists pg_cron;';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE EXCEPTION 'pg_net is not installed. Run: create extension if not exists pg_net with schema extensions;';
  END IF;

  FOR k IN 2..7 LOOP
    job := 'recheck-d' || k;
    -- Idempotent: unschedule by name first so re-running this file cannot
    -- leave two jobs firing the same date twice.
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = job) THEN
      PERFORM cron.unschedule(job);
    END IF;
    PERFORM cron.schedule(job, format('%s 10 * * *', 18 + k), format('SELECT app_cron.recheck(%s);', k));
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Monitoring.
-- ---------------------------------------------------------------------------

-- What the sweep actually did. This is the history Vercel Hobby never had.
-- `status` is pg_cron's view of the CALL, not of the reconcile: a 200 and a 500
-- both read as succeeded here, because pg_net dispatched fine either way. Join
-- net._http_response on the returned request id for the HTTP status, or read
-- reconciliation_runs, which is the real evidence a date was re-run.
CREATE OR REPLACE VIEW app_cron.sweep_history AS
  SELECT j.jobname,
         d.status,
         d.start_time,
         d.end_time,
         d.end_time - d.start_time AS duration,
         d.return_message
    FROM cron.job_run_details d
    JOIN cron.job j ON j.jobid = d.jobid
   WHERE j.jobname LIKE 'recheck-d%'
   ORDER BY d.start_time DESC;

REVOKE ALL ON app_cron.sweep_history FROM PUBLIC, anon, authenticated;
