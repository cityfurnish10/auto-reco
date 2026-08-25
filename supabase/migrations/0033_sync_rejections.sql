-- 0033_sync_rejections.sql
--
-- WHY: a guard added manual items, they never reached the platform, and there
-- was no way to find out why.
--
-- applyBatch already refuses rows for good reasons — a manual entry with no
-- photograph, an item kind that cannot travel in that direction, a quantity
-- that contradicts the kind. Each refusal was returned to the PHONE, which
-- marked it and kept it. That is correct behaviour and it is also a dead end:
-- the record of the refusal existed only in one guard's browser storage, on a
-- handset nobody else can open.
--
-- So a supervisor asking "where did those three items go?" had nowhere to look,
-- and the answer was sitting in IndexedDB on a phone at a gate.
--
-- This is the other half of that: every refusal is written down here, with the
-- reason, attributable to a guard and a device. It is a LOG, not a queue —
-- nothing reads it to retry anything. Its whole job is to make a silent failure
-- answerable.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS gate_sync_rejections (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which row the phone was trying to send, in its own identifiers. Kept even
  -- though nothing here joins on them: it is what lets a guard reading the
  -- queue on their phone and a manager reading this table talk about the same
  -- item.
  client_id     TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('trip','scan','void','shift','face')),

  city          TEXT NOT NULL,
  site_code     TEXT,
  guard_id      UUID REFERENCES app_users(id),
  device_id     UUID REFERENCES gate_devices(id),

  -- The reason, exactly as applyBatch phrased it. Not a code: the phrasing is
  -- the diagnosis, and inventing an enum here would mean maintaining two
  -- vocabularies that drift.
  reason        TEXT NOT NULL,

  -- Enough of the payload to understand the refusal without keeping a full
  -- copy of something we deliberately declined to store.
  summary       JSONB,

  business_date DATE,
  rejected_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The same row re-sent produces the same refusal every time a phone retries,
-- and a queue that never drains would otherwise fill this table with one item
-- repeated a thousand times. One row per client_id, updated rather than piled
-- up — the count of ATTEMPTS is the interesting number, not the count of rows.
ALTER TABLE gate_sync_rejections
  ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_gsr_client
  ON gate_sync_rejections (client_id);

-- The supervisor's read: what was refused at my gate today.
CREATE INDEX IF NOT EXISTS idx_gsr_city_date
  ON gate_sync_rejections (city, business_date DESC);

COMMENT ON TABLE gate_sync_rejections IS
  'Rows the gate refused, with the reason. Exists so a refusal is answerable by somebody other than the guard holding the phone.';
COMMENT ON COLUMN gate_sync_rejections.attempts IS
  'How many times the phone has re-sent this. A climbing number means a queue that cannot drain.';

-- ---------------------------------------------------------------------------
-- Re-sends collapse onto the row they repeat.
-- ---------------------------------------------------------------------------
-- A phone retries a refused row on every drain, so the same refusal arrives
-- again and again. A thousand identical rows would bury the one number that
-- matters — how long this has been failing — so an insert for a client id we
-- already hold becomes an UPDATE that bumps the count instead.
--
-- Done as a trigger rather than in the application because PostgREST cannot
-- express `ON CONFLICT DO UPDATE SET attempts = attempts + 1`, and doing it as
-- read-then-write from a serverless function is a race with every other phone.
CREATE OR REPLACE FUNCTION gate_sync_rejection_bump()
  RETURNS TRIGGER LANGUAGE plpgsql AS
$$
BEGIN
  UPDATE gate_sync_rejections
     SET attempts    = gate_sync_rejections.attempts + 1,
         reason      = NEW.reason,
         summary     = COALESCE(NEW.summary, gate_sync_rejections.summary),
         rejected_at = NEW.rejected_at
   WHERE client_id = NEW.client_id;

  IF FOUND THEN
    RETURN NULL;   -- swallow the insert; the update above did the work
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_gsr_bump ON gate_sync_rejections;
CREATE TRIGGER trg_gsr_bump
  BEFORE INSERT ON gate_sync_rejections
  FOR EACH ROW EXECUTE FUNCTION gate_sync_rejection_bump();
