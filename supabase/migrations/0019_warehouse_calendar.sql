-- When each warehouse is shut, mirrored from the delivery app's master data.
--
-- WHY: lib/engine/schedule.ts has carried WEEKLY_OFF_DAY as a literal map --
-- Thursday for Mumbai, Pune and Hyderabad -- written from what somebody said in
-- a conversation. The delivery app has held the same fact as EDITABLE OPS DATA
-- the whole time, in its `master_datas` collection, and nothing here had looked:
--
--   master = "weekly_off"    34 rows  { city, "week day", status }
--   master = "holiday"       29 rows  { date: "d/m/yyyy", city: [..], status }
--
-- Verified live 2026-07-31: for the five cities we reconcile, the weekly rule in
-- that collection is IDENTICAL to the hardcoded map. So this is not a
-- correction, it is a source upgrade, with two consequences worth the table:
--
--   * An ops change in the delivery app reaches this system on the next run,
--     instead of waiting for someone to notice and ship a deploy.
--   * TWENTY-NINE ONE-OFF HOLIDAYS the reconciler has never known about. On
--     each of those days a city was shut, every floor source correctly went
--     quiet, and this system called it a missing register.
--
-- WHY A TABLE RATHER THAN A LIVE READ: only the reconcile pipeline can reach
-- Mongo. The digest and both dashboards are Supabase-only, and the register
-- handover model needs this calendar on every one of those surfaces.
--
-- WHY RULES AND NOT MATERIALISED DAYS: a weekly rule answers for any date, past
-- or future, in constant space. Materialising one row per city per day would
-- need a horizon, and lastWorkingDay() has to be able to walk backwards past
-- whatever that horizon was.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS public.warehouse_calendar (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city         TEXT NOT NULL
               CHECK (city IN ('DELHI','MUMBAI','PUNE','HYDERABAD','BANGALORE')),

  -- Exactly one of these is set. 0=Sunday .. 6=Saturday, matching
  -- JS getUTCDay() and the WEEKLY_OFF_DAY convention it replaces.
  weekday      SMALLINT CHECK (weekday BETWEEN 0 AND 6),
  holiday_date DATE,

  synced_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A row is a weekly rule XOR a one-off closure, never both and never neither.
  CONSTRAINT warehouse_calendar_one_kind
    CHECK ((weekday IS NULL) <> (holiday_date IS NULL))
);

-- NULLS NOT DISTINCT, deliberately: without it Postgres treats every
-- (city, NULL, '2026-07-11') as unique and a daily re-sync accumulates a
-- duplicate holiday per run. Requires PG15, which Supabase is.
CREATE UNIQUE INDEX IF NOT EXISTS warehouse_calendar_key
  ON public.warehouse_calendar (city, weekday, holiday_date) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS idx_warehouse_calendar_city
  ON public.warehouse_calendar (city);

ALTER TABLE public.warehouse_calendar ENABLE ROW LEVEL SECURITY;

-- Readable by any signed-in user, including a city manager looking at another
-- city's off day: a public-holiday calendar carries nothing sensitive, and the
-- alternative is a manager's own board being unable to explain its own gaps.
-- Writes are service-role only (the reconcile pipeline), which bypasses RLS.
DROP POLICY IF EXISTS warehouse_calendar_select ON public.warehouse_calendar;
CREATE POLICY warehouse_calendar_select ON public.warehouse_calendar
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.warehouse_calendar IS
  'Mirror of the delivery app master_datas weekly_off + holiday rows. Refreshed '
  'every reconcile run; see lib/connectors/warehouse-calendar.ts. Empty is a '
  'valid state -- every reader falls back to WEEKLY_OFF_DAY in lib/engine/schedule.ts.';
