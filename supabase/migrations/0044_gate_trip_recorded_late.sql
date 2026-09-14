-- 0044_gate_trip_recorded_late.sql
--
-- A guard may record a trip for YESTERDAY, and it says so.
--
-- Decided 14 Sep 2026: a guard can choose the date they are scanning for —
-- today, or yesterday only — and anything recorded for yesterday is marked as
-- entered late. The usual case is a truck that went unrecorded the evening
-- before. Further back is refused on the server, not just hidden on the phone.
--
-- What a late trip does:
--   * movement_date is the calendar date the guard chose (always the day before
--     the trip was opened; anything else is ignored by lib/gate/sync.ts);
--   * business_date, which the reconciliation reads, is set to that date, so
--     the items are counted on the day they moved rather than the day typed in;
--   * the real scan times are kept untouched, so the lateness stays visible;
--   * recorded_late is set on the trip and on every scan in it, so the Activity
--     screen, the downloads and anyone querying later can see it at a glance.
--
-- Safe to re-run.

ALTER TABLE gate_trips
  ADD COLUMN IF NOT EXISTS movement_date DATE,
  ADD COLUMN IF NOT EXISTS recorded_late BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE gate_scans
  ADD COLUMN IF NOT EXISTS recorded_late BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN gate_trips.movement_date IS
  'Calendar date (IST) the guard said this trip was for, when recorded late — '
  'always the day before opened_at. Null for a trip recorded on its own day.';
COMMENT ON COLUMN gate_trips.recorded_late IS
  'Entered on a later day than it happened. Its scans count on movement_date.';

CREATE INDEX IF NOT EXISTS gate_trips_movement_date_idx
  ON gate_trips (movement_date) WHERE movement_date IS NOT NULL;
