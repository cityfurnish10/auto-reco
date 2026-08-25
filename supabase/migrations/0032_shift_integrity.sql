-- 0032_shift_integrity.sql
--
-- A GUARD HAD SEVENTEEN OPEN SHIFTS. Measured 2026-08-25, one guard, oldest
-- from the 21st. It is worth spelling out how, because the shape of the bug is
-- more instructive than the count:
--
--   1. guard_shifts never got the "one open per guard" index that gate_trips
--      has. Nothing stopped a second one existing.
--   2. Nothing ever CLOSES a shift. checkOut() fires only on "switch guard",
--      so a guard who ends their day by pocketing the phone stays on duty.
--   3. Bootstrap asks for THE open shift with .maybeSingle(). Two rows make
--      that an error, and the route read `.data ?? null` — swallowing it.
--   4. So the app decided nobody was checked in, sent the guard to check-in,
--      and created shift number three. Then four.
--
-- Self-feeding, silent, and it made attendance worthless: no hours, no end,
-- and a queue of open shifts that could never be resolved from the app.
--
-- This file fixes the data and the two structural holes. The swallowed error
-- and the missing end-of-shift button are fixed in code alongside it.
--
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. Say when a shift ended BY ITSELF.
-- ---------------------------------------------------------------------------
-- Attendance has to stay honest. A shift closed by a nightly sweep is not
-- evidence that the guard worked until that moment — it is evidence that
-- nobody told us when they left. Recording the difference is the whole reason
-- this column exists; without it, an auto-closed shift is indistinguishable
-- from a real one and every hours figure built on it is a guess presented as a
-- measurement.
ALTER TABLE guard_shifts
  ADD COLUMN IF NOT EXISTS auto_closed BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN guard_shifts.auto_closed IS
  'TRUE when a nightly sweep closed this, not the guard. Such a shift proves attendance, never hours.';

-- ---------------------------------------------------------------------------
-- 2. Close the backlog.
-- ---------------------------------------------------------------------------
-- Every currently-open shift older than 16 hours. The checkout time is set to
-- 16 hours after check-in rather than to now(): claiming a guard was on duty
-- for four days because nobody pressed a button would be inventing a fact, and
-- these rows are about to become the attendance record.
UPDATE guard_shifts
   SET status = 'closed',
       checked_out_at = checked_in_at + INTERVAL '16 hours',
       auto_closed = TRUE
 WHERE status = 'open'
   AND checked_in_at < now() - INTERVAL '16 hours';

-- Anything still open and duplicated: keep the newest, close the rest. The
-- index below cannot be created while a guard holds two.
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY guard_id ORDER BY checked_in_at DESC) AS rn
  FROM guard_shifts WHERE status = 'open'
)
UPDATE guard_shifts s
   SET status = 'closed',
       checked_out_at = s.checked_in_at + INTERVAL '16 hours',
       auto_closed = TRUE
  FROM ranked r
 WHERE r.id = s.id AND r.rn > 1;

-- ---------------------------------------------------------------------------
-- 3. Make it structurally impossible to happen again.
-- ---------------------------------------------------------------------------
-- The same protection gate_trips has had since 0023. A guard is in one place
-- at a time, so a second open shift is never a real event — it is always a bug,
-- and it should fail loudly at the moment it is written rather than quietly
-- poison every read afterwards.
CREATE UNIQUE INDEX IF NOT EXISTS uq_gs_one_open_per_guard
  ON guard_shifts (guard_id) WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- 4. Trips left open overnight.
-- ---------------------------------------------------------------------------
-- One was open from yesterday. Nothing abandons them, and because the resume
-- lookup was not bounded by business date, a guard opening the app this
-- morning would have been offered "resume trip" on yesterday's truck.
--
-- Twelve hours, not sixteen: a trip is one truck at one gate. Anything still
-- open half a day later was forgotten, not in progress.
UPDATE gate_trips
   SET status = 'abandoned',
       closed_at = COALESCE(closed_at, opened_at + INTERVAL '12 hours')
 WHERE status = 'open'
   AND opened_at < now() - INTERVAL '12 hours';

-- ---------------------------------------------------------------------------
-- 4b. "I was here and nothing moved."
-- ---------------------------------------------------------------------------
-- THE PROBLEM THIS SOLVES. The reconcile connector treats a city with no gate
-- scans as a SOURCE THAT FAILED — it warns and marks the city incomplete,
-- which demotes the gate for that day. That is the right default: silence
-- usually means an unmanned shift or a phone that never synced, and reading it
-- as "nothing moved" would turn an outage into a flood of false absences.
--
-- But a genuinely quiet gate produces exactly the same silence, and there was
-- no way to tell the two apart. A guard who sat through a shift with no truck
-- had no way to say so, and the day was recorded as a failure.
--
-- One flag on the shift closes that. A closed shift carrying it, with no scans
-- against it, is a CONFIDENT ZERO rather than an absent source — and it is
-- attributable to the person who asserted it, which a separate table keyed
-- only on a date would not be.
ALTER TABLE guard_shifts
  ADD COLUMN IF NOT EXISTS nothing_moved BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN guard_shifts.nothing_moved IS
  'The guard asserted the gate was quiet. Lets the reconciler read no scans as a real zero rather than a dead source.';

-- A claim that nothing moved, on a shift that recorded movements, is a
-- contradiction — and it would be read as a confident zero for a day that had
-- traffic.
--
-- NOT ENFORCED HERE, and the reason is a limitation rather than a choice:
-- Postgres does not allow a subquery inside a CHECK, and this rule is
-- inherently about rows in another table. It is enforced in applyBatch, which
-- refuses the flag when that guard has recorded scans on that business date,
-- and read defensively by the connector, which requires BOTH the flag and an
-- absence of scans before treating a day as a real zero. Two independent
-- checks, neither of which can be reached by a phone.
--
-- The index the connector uses to ask the question cheaply:
CREATE INDEX IF NOT EXISTS idx_gs_quiet
  ON guard_shifts (city, business_date) WHERE nothing_moved;

-- ---------------------------------------------------------------------------
-- 5. The nightly sweep.
-- ---------------------------------------------------------------------------
-- PLAIN SQL, called straight by pg_cron. The other two gate jobs POST to an
-- API route because they need Metabase and Odoo; this one touches nothing but
-- these two tables, and an HTTP round trip would add a failure mode for no
-- reason at all.
CREATE OR REPLACE FUNCTION app_cron.gate_day_end()
  RETURNS TABLE (shifts_closed INT, trips_abandoned INT)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app_cron AS
$$
DECLARE s INT; t INT;
BEGIN
  UPDATE guard_shifts
     SET status = 'closed',
         checked_out_at = checked_in_at + INTERVAL '16 hours',
         auto_closed = TRUE
   WHERE status = 'open' AND checked_in_at < now() - INTERVAL '16 hours';
  GET DIAGNOSTICS s = ROW_COUNT;

  UPDATE gate_trips
     SET status = 'abandoned',
         closed_at = COALESCE(closed_at, opened_at + INTERVAL '12 hours')
   WHERE status = 'open' AND opened_at < now() - INTERVAL '12 hours';
  GET DIAGNOSTICS t = ROW_COUNT;

  RETURN QUERY SELECT s, t;
END $$;

REVOKE ALL ON FUNCTION app_cron.gate_day_end() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION 'pg_cron is not installed.';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'gate-day-end') THEN
    PERFORM cron.unschedule('gate-day-end');
  END IF;
  -- 19:00 UTC = 00:30 IST. Deliberately BEFORE gate-media at 01:00 IST, so a
  -- shift is closed before the sweep that deletes its selfie considers it.
  PERFORM cron.schedule('gate-day-end', '0 19 * * *', 'SELECT app_cron.gate_day_end();');
END $$;

-- ---------------------------------------------------------------------------
-- 6. What is left.
-- ---------------------------------------------------------------------------
DO $$
DECLARE os INT; ot INT; ac INT;
BEGIN
  SELECT count(*) INTO os FROM guard_shifts WHERE status = 'open';
  SELECT count(*) INTO ot FROM gate_trips   WHERE status = 'open';
  SELECT count(*) INTO ac FROM guard_shifts WHERE auto_closed;
  RAISE NOTICE 'open shifts: %, open trips: %, auto-closed so far: %', os, ot, ac;
END $$;
