-- 0028_gate_schedules.sql
--
-- The two scheduled jobs the gate app needs, from Postgres.
--
-- WHY NOT VERCEL. Hobby caps the project at two cron jobs and both are taken by
-- the reconcile and the digest. 0018 and 0021 already moved scheduled work into
-- the database for exactly this reason, so this follows the same shape: a
-- SECURITY DEFINER function that POSTs to the route with the Vault secret, and
-- a named job that is unscheduled before it is scheduled so re-running the file
-- cannot leave two of them.
--
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. Today's and tomorrow's expected pickings.
-- ---------------------------------------------------------------------------
-- The gate app downloads this list so it can check a scan without asking Odoo
-- per item, and without a connection at all. It must exist BEFORE a shift
-- starts, not be fetched when someone first wonders about it.
CREATE OR REPLACE FUNCTION app_cron.gate_expected()
  RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = extensions, public, app_cron AS
$$
  SELECT net.http_post(
    url := app_cron.base_url() || '/api/cron/gate-expected',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || app_cron.secret(),
      'Content-Type', 'application/json'
    ),
    -- Two Metabase queries against Odoo, which is not a fast database.
    timeout_milliseconds := 60000
  );
$$;

REVOKE ALL ON FUNCTION app_cron.gate_expected() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Expiring the photographs.
-- ---------------------------------------------------------------------------
-- Attendance selfies at 45 days, item photos at 90. The RECORDS survive; only
-- the images go, so an attendance row still proves somebody checked in at a
-- time and a place -- it simply can no longer be disputed visually.
CREATE OR REPLACE FUNCTION app_cron.gate_media()
  RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = extensions, public, app_cron AS
$$
  SELECT net.http_post(
    url := app_cron.base_url() || '/api/cron/gate-media',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || app_cron.secret(),
      'Content-Type', 'application/json'
    ),
    timeout_milliseconds := 60000
  );
$$;

REVOKE ALL ON FUNCTION app_cron.gate_media() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Schedule them.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION 'pg_cron is not installed. Run: create extension if not exists pg_cron;';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE EXCEPTION 'pg_net is not installed. Run: create extension if not exists pg_net with schema extensions;';
  END IF;

  -- 01:30 UTC = 07:00 IST. Before any gate opens, so the first guard of the day
  -- finds the list already there rather than waiting on Odoo at the moment a
  -- truck is in front of them.
  IF EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = 'gate-expected') THEN
    PERFORM cron.unschedule('gate-expected');
  END IF;
  PERFORM cron.schedule('gate-expected', '30 1 * * *', 'SELECT app_cron.gate_expected();');

  -- 19:30 UTC = 01:00 IST. Deliberately in the dead of night and nowhere near
  -- the reconcile: deleting several hundred files is not urgent, and it should
  -- never compete for the same minute as the job the business depends on.
  IF EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = 'gate-media') THEN
    PERFORM cron.unschedule('gate-media');
  END IF;
  PERFORM cron.schedule('gate-media', '30 19 * * *', 'SELECT app_cron.gate_media();');
END $$;

-- ---------------------------------------------------------------------------
-- 4. What they did.
-- ---------------------------------------------------------------------------
-- Same caveat as 0018 and 0021: pg_cron records the CALL, not the outcome. The
-- response is in net._http_response, and the real evidence is the data --
-- gate_expected_items for the first job, and a shrinking count of non-null
-- photo paths for the second.
CREATE OR REPLACE VIEW app_cron.gate_job_history AS
  SELECT j.jobname, r.start_time, r.status, r.return_message
  FROM cron.job_run_details r
  JOIN cron.job j ON j.jobid = r.jobid
  WHERE j.jobname IN ('gate-expected', 'gate-media')
  ORDER BY r.start_time DESC;

COMMENT ON VIEW app_cron.gate_job_history IS
  'Recent runs of the gate schedules. Reports the call, not the result — see net._http_response for that.';
