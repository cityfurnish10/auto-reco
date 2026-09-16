-- 0049_run_day_definition.sql
--
-- Which definition of "a day" a run used.
--
-- WHY. From 13 September 2026 a business date means the CALENDAR day, midnight
-- to midnight IST. Before it, the 15:00→15:00 warehouse day. Both meanings now
-- live in the same `business_date` column across variances, run_city_stats,
-- movement_events and gate_scans — because re-attributing four thousand
-- historical rows to make a screen read consistently is a far larger risk than
-- carrying two meanings and labelling them.
--
-- Labelling them is what this column does. Without it, "2026-09-12: 397
-- movements" and "2026-09-13: 273" are two numbers measured with different
-- rulers and nothing on the row says so. Anyone comparing a week that spans the
-- seam — a trend line, a leaderboard, an owner asking why Friday looks busier
-- than Thursday — would be reading an artefact of the cutover as a change in
-- the business.
--
-- Recorded per RUN rather than derived from the date, because the two can
-- legitimately disagree: CALENDAR_DAYS_FROM is overridable, so a replay or a
-- rolled-back cutover produces runs whose definition is not what today's code
-- would choose for that date. What a run actually did is a fact; what the code
-- would do now is a guess.
--
-- Existing rows are backfilled to 'business_15' — every run before this
-- migration used the 15:00 rule by construction.
--
-- Safe to re-run.

ALTER TABLE public.reconciliation_runs
  ADD COLUMN IF NOT EXISTS day_definition TEXT NOT NULL DEFAULT 'business_15';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reconciliation_runs_day_definition_chk'
  ) THEN
    ALTER TABLE public.reconciliation_runs
      ADD CONSTRAINT reconciliation_runs_day_definition_chk
      CHECK (day_definition IN ('business_15', 'calendar'));
  END IF;
END $$;

COMMENT ON COLUMN public.reconciliation_runs.day_definition IS
  'What business_date meant for this run. business_15 = 15:00-15:00 IST (every '
  'run before 13 Sep 2026). calendar = midnight-midnight IST. Two meanings '
  'share the column; this is the only thing that distinguishes them.';
