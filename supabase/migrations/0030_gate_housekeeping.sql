-- 0030_gate_housekeeping.sql
--
-- Two jobs that have been waiting, and one thing the pilot left behind.
--
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. A trip names its delivery agent. (Was 0029; folded in here.)
-- ---------------------------------------------------------------------------
-- The app already refuses to start a trip without one, and the sync endpoint
-- refuses it again. This is the third line — the one that holds when a future
-- change forgets the first two, which is the only kind of guarantee worth
-- having about a field this load-bearing: the agent's name is how a gate row is
-- later matched to a planned movement.
--
-- NOT VALID on purpose. Eleven trips were recorded before the field was
-- mandatory and some have no agent. Enforcing on new rows is the point;
-- rewriting history to satisfy a constraint would be inventing a fact.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gate_trips_agent_named'
  ) THEN
    ALTER TABLE gate_trips
      ADD CONSTRAINT gate_trips_agent_named
      CHECK (driver_name IS NOT NULL AND length(btrim(driver_name)) >= 2)
      NOT VALID;
  END IF;
END $$;

COMMENT ON CONSTRAINT gate_trips_agent_named ON gate_trips IS
  'Every trip names its delivery agent. NOT VALID: pre-pilot rows predate the rule.';

-- ---------------------------------------------------------------------------
-- 2. Retire the phones that were only ever paired to test with.
-- ---------------------------------------------------------------------------
-- Nineteen active devices exist for DELHI and twelve have never been used —
-- one per pairing link generated while building. Left alone, the device list
-- stops meaning anything on the day real guards are issued phones, and a
-- device row is a live credential: a token somebody could still present.
--
-- Only the NEVER-USED ones, and only those paired before today. A device that
-- has reported even once might be a real handset in somebody's pocket, and
-- revoking that is worse than leaving clutter.
-- A revoked credential should say why it was revoked; the table had nowhere to
-- record that, so it gets somewhere. Cheap, and this is the moment it is needed.
ALTER TABLE gate_devices ADD COLUMN IF NOT EXISTS revoked_reason TEXT;

UPDATE gate_devices
   SET status = 'revoked',
       revoked_at = now(),
       revoked_reason = 'never used — paired during the build'
 WHERE status = 'active'
   AND last_seen_at IS NULL
   AND created_at < date_trunc('day', now());

-- ---------------------------------------------------------------------------
-- 3. What is left.
-- ---------------------------------------------------------------------------
DO $$
DECLARE live INT; retired INT;
BEGIN
  SELECT count(*) INTO live    FROM gate_devices WHERE status = 'active';
  SELECT count(*) INTO retired FROM gate_devices WHERE status = 'revoked';
  RAISE NOTICE 'gate_devices: % active, % revoked', live, retired;
END $$;
