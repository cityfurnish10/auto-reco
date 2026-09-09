-- 0038_gate_enrich_schedule.sql
--
-- Run the gate-scan enrichment (migration 0037, /api/cron/gate-enrich).
--
-- FROM POSTGRES, NOT VERCEL, for the reason 0028 and 0030 already give: Hobby
-- caps the project at two cron jobs and the reconcile and the digest have both.
--
-- EVERY TWO HOURS during working hours rather than once a night. Enrichment is
-- what turns a bare serial into "# Belle Chest of Drawer" for a manager reading
-- the Gate screen, and a manager looking at this morning's trips should not
-- have to wait until tomorrow to see them. It is cheap: one Metabase query per
-- run over at most 500 rows, and rows already done are excluded by a partial
-- index, so a quiet day costs a single empty query.
--
-- Unscheduled before scheduled, so re-running this file cannot leave two.
--
-- Safe to re-run.

CREATE OR REPLACE FUNCTION app_cron.gate_enrich()
  RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = extensions, public, app_cron AS
$$
  SELECT net.http_post(
    url := app_cron.base_url() || '/api/cron/gate-enrich',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || app_cron.secret(),
      'Content-Type', 'application/json'
    ),
    -- One Metabase query against Odoo, which is not a fast database.
    timeout_milliseconds := 60000
  );
$$;

REVOKE ALL ON FUNCTION app_cron.gate_enrich() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'gate-enrich') THEN
    PERFORM cron.unschedule('gate-enrich');
  END IF;
  -- 03:30 UTC = 09:00 IST, then every two hours to 19:00 IST.
  PERFORM cron.schedule('gate-enrich', '30 3,5,7,9,11,13 * * *',
                        'SELECT app_cron.gate_enrich();');
END $$;
