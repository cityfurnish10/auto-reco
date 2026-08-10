-- 0021_variance_noise.sql
--
-- Two changes, both in service of one measurement taken on 2026-08-10:
-- 17,895 variance rows stood open, and the floor's own manual reconciliation
-- finds a handful a day. Almost none of the difference was missing stock.
--
--   1. movement_events.suppressed_reason gains 'odoo_nearby_day'.
--
--      Odoo's posting window is +/-1 day, so one posting row is pulled into
--      three consecutive runs. On the two neighbouring days it has no floor
--      company, grades as an Odoo-only row, and files a variance against a
--      movement that was reconciled on its own day. 525 of 941 open "Odoo
--      Posting Only" rows in the retained window were exactly that.
--
--      The engine now drops those unjudged. The ledger records WHY, and this
--      widens the CHECK so it can. lib/db/persist.ts downgrades the value to
--      'other' on a 23514 check_violation, so a deploy that lands before this
--      migration keeps writing the ledger -- only the label is coarser.
--
--   2. A daily pg_cron job that settles rows nobody will ever work.
--
--      13,492 of the 17,895 had a business_date older than the oldest day
--      source_rows still retains, so no re-run can ever look at them again;
--      prune_expired only deletes rows that are ALREADY closed, and
--      resolveStaleOpenVariances only runs when a date is reconciled again --
--      which for a pruned date can no longer happen. The count could only grow.
--
--      /api/cron/settle closes them with an honest closure_reason
--      ("Aged out -- source data expired", or "No action needed -- information
--      only" where the engine's own label for the row is tier 3). Nothing a
--      human has touched is altered, and nothing newer than 8 days is, so the
--      re-check sweep below still owns every date it can still re-run.
--
-- PREREQUISITES: the same ones 0018 lists (pg_cron, pg_net, the cron_secret
-- vault entry). If 0018 has been applied, they are already in place.
--
-- Safe to re-run.


-- ---------------------------------------------------------------------------
-- 1. The new suppression reason.
-- ---------------------------------------------------------------------------

-- DROP + re-ADD, matching the pattern 0006 and 0009 already use for CHECK
-- changes. The column is nullable and every existing value is in the new list,
-- so this never fails validation against stored rows.
ALTER TABLE public.movement_events
  DROP CONSTRAINT IF EXISTS movement_events_suppressed_reason_check;

ALTER TABLE public.movement_events
  ADD CONSTRAINT movement_events_suppressed_reason_check
  CHECK (suppressed_reason IS NULL OR suppressed_reason IN
         ('dt_all_pending','silent_ocr','failed_delivery_return',
          'odoo_nearby_day','other'));

COMMENT ON COLUMN public.movement_events.suppressed_reason IS
  'Why the engine withheld an accusation for this unit. odoo_nearby_day = an Odoo-only posting for a unit a FLOOR source documented on a nearby day, where the movement was already reconciled; the +/-1 posting window pulls one Odoo row into three runs.';


-- ---------------------------------------------------------------------------
-- 2. The daily settle sweep.
-- ---------------------------------------------------------------------------

-- Reuses app_cron.base_url() and app_cron.secret() from 0018 rather than
-- redefining them: two copies of the deployment alias is exactly how one of
-- them ends up pointing at a dead build.
CREATE OR REPLACE FUNCTION app_cron.settle()
  RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = extensions, public, app_cron AS
$$
  SELECT net.http_post(
    -- POST, not GET: the route treats GET as a dry run on purpose, so that a
    -- mistyped URL in a browser cannot close thirteen thousand rows.
    url := app_cron.base_url() || '/api/cron/settle',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || app_cron.secret(),
      'Content-Type', 'application/json'
    ),
    -- pg_net defaults to five seconds. This is a bounded UPDATE pass, but the
    -- first run has a five-figure backlog to clear.
    timeout_milliseconds := 60000
  );
$$;

REVOKE ALL ON FUNCTION app_cron.settle() FROM PUBLIC, anon, authenticated;

-- 10:15 UTC = 15:45 IST. Five minutes AHEAD of the recheck-d2 job (10:20 UTC),
-- and both bounds matter:
--   * after 15:00 IST, so "today" in the route resolves to the business date
--     the sweep below is about to re-run -- the same rule 0018 documents;
--   * before the re-check sweep, so a date it is about to re-run is never
--     settled a few seconds earlier by this job. The 8-day floor in
--     lib/reconcile/settle.ts already guarantees that; the ordering makes it
--     true twice.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION 'pg_cron is not installed. Run: create extension if not exists pg_cron;';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE EXCEPTION 'pg_net is not installed. Run: create extension if not exists pg_net with schema extensions;';
  END IF;

  -- Idempotent: unschedule by name first so re-running this file cannot leave
  -- two jobs settling on the same afternoon.
  IF EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = 'settle-queue') THEN
    PERFORM cron.unschedule('settle-queue');
  END IF;
  PERFORM cron.schedule('settle-queue', '15 10 * * *', 'SELECT app_cron.settle();');
END $$;

-- What the settle sweep did, alongside 0018's sweep_history. Same caveat: pg_cron
-- reports the CALL, not the outcome -- join net._http_response on the returned
-- request id, or read variances.closure_reason, which is the real evidence.
CREATE OR REPLACE VIEW app_cron.settle_history AS
  SELECT j.jobname,
         d.status,
         d.start_time,
         d.end_time,
         d.end_time - d.start_time AS duration,
         d.return_message
    FROM cron.job_run_details d
    JOIN cron.job j ON j.jobid = d.jobid
   WHERE j.jobname = 'settle-queue'
   ORDER BY d.start_time DESC;

REVOKE ALL ON app_cron.settle_history FROM PUBLIC, anon, authenticated;
