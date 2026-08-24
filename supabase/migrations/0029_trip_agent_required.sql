-- 0029_trip_agent_required.sql
--
-- A trip must name the delivery agent, not only the vehicle.
--
-- WHY IN THE DATABASE. The app checks it and the sync endpoint checks it, but
-- an old build lingers on a guard's personal phone for weeks and only the
-- database is present for every write however it arrives. A trip with no agent
-- cannot be traced to a person once the truck has gone, which is most of the
-- reason for recording it at all.
--
-- NOT VALID is deliberate and is the whole trick: the constraint applies to
-- every new row from now on, and existing trips — recorded before the field was
-- required — are left alone. Validating them would either fail the migration or
-- force inventing a name for a truck that has already left, and a made-up name
-- in an audit trail is worse than an honest blank.
--
-- Safe to re-run.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.gate_trips'::regclass
       AND conname = 'gate_trips_agent_named'
  ) THEN
    ALTER TABLE gate_trips
      ADD CONSTRAINT gate_trips_agent_named
      CHECK (driver_name IS NOT NULL AND length(btrim(driver_name)) >= 2)
      NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN gate_trips.driver_name IS
  'The delivery agent. Required on new trips (0029); historical rows may be null.';
