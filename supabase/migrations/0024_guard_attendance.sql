-- 0024_guard_attendance.sql
--
-- Guard attendance, in the same app as the gate scanning. Separate migration
-- from 0023 because it is a separate concern: the movement log stands on its
-- own and must not be blocked or rolled back by anything here.
--
-- MATCHING RUNS ON THE DEVICE. The reference photo is cached on the guard's
-- phone at enrolment (guard_devices.reference_photo) and the live selfie is
-- compared there. Only the RESULT is uploaded -- a score and a verdict. No face
-- image is ever sent to a third party for comparison, which is the cleanest
-- position under India's DPDP Act and also means check-in works with no signal.
--
-- The trade is accuracy in poor light, and the night shift is exactly where
-- light is worst. That is why an uncertain match ROUTES TO A MANAGER and never
-- locks the guard out: a guard refused entry at 9pm in the rain stops using the
-- app permanently, and then there is no attendance record at all.
--
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. guard_shifts — one row per shift worked.
-- ---------------------------------------------------------------------------
-- Three guards are planned per city -- two by day, one at night -- but cover is
-- sometimes a single person, so nothing here assumes a particular guard is on
-- duty or that a shift exists for a given slot. A shift with nobody checked in
-- is a fact worth alerting on, not an impossible state to forbid.
CREATE TABLE IF NOT EXISTS guard_shifts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_shift_id   TEXT NOT NULL UNIQUE,   -- offline-safe, same reasoning as 0023
  guard_id          UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  city              TEXT NOT NULL
                    CHECK (city IN ('DELHI','MUMBAI','PUNE','HYDERABAD','BANGALORE')),
  site_code         TEXT NOT NULL,
  device_id         TEXT,

  checked_in_at     TIMESTAMPTZ NOT NULL,
  checked_out_at    TIMESTAMPTZ,
  -- Derived server-side from checked_in_at. Kept even though shifts are a
  -- calendar-day concept for the guard, so attendance and movements can be
  -- lined up against the same day without re-deriving in two places.
  business_date     DATE NOT NULL,

  -- Location at check-in / check-out, and whether each fell inside the gate
  -- geofence. NULL geo_ok means no fix was available, which is not a failure.
  in_lat            DOUBLE PRECISION,
  in_lng            DOUBLE PRECISION,
  in_geo_ok         BOOLEAN,
  out_lat           DOUBLE PRECISION,
  out_lng           DOUBLE PRECISION,
  out_geo_ok        BOOLEAN,

  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','closed','auto_closed')),
  -- A guard who forgets to check out leaves the shift open forever, and an
  -- always-open shift is indistinguishable from one still being worked. A sweep
  -- closes these and says so, rather than pretending the record is complete.
  auto_closed_reason TEXT,

  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT guard_shifts_closed_has_time CHECK (
    status = 'open' OR checked_out_at IS NOT NULL
  ),
  CONSTRAINT guard_shifts_autoclose_has_reason CHECK (
    status <> 'auto_closed' OR auto_closed_reason IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_shift_city_date ON guard_shifts (city, business_date);
CREATE INDEX IF NOT EXISTS idx_shift_open ON guard_shifts (city, guard_id) WHERE status = 'open';

COMMENT ON TABLE guard_shifts IS
  'Guard attendance — geofenced check-in and check-out. One row per shift worked.';

-- ---------------------------------------------------------------------------
-- 2. guard_face_checks — every verification event.
-- ---------------------------------------------------------------------------
-- Covers check-in, check-out and the 2-3 random in-shift prompts. One table
-- rather than three because they are the same event with a different trigger,
-- and the manager reviewing them wants one queue, not three.
CREATE TABLE IF NOT EXISTS guard_face_checks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_check_id TEXT NOT NULL UNIQUE,
  shift_id        UUID REFERENCES guard_shifts(id) ON DELETE CASCADE,
  guard_id        UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  city            TEXT NOT NULL
                  CHECK (city IN ('DELHI','MUMBAI','PUNE','HYDERABAD','BANGALORE')),
  device_id       TEXT,

  trigger         TEXT NOT NULL
                  CHECK (trigger IN ('check_in','check_out','random')),
  captured_at     TIMESTAMPTZ NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Storage path of the selfie, in the 45-day attendance bucket. The image is
  -- kept for dispute review by a human -- it is NOT what the match ran against,
  -- because the match already happened on the phone.
  selfie_path     TEXT,

  -- The on-device result. score is whatever the local matcher produced; verdict
  -- is the thresholded call. Both stored: a threshold that turns out wrong can
  -- be re-evaluated against the scores, which is impossible if only the verdict
  -- was kept.
  match_score     REAL,
  verdict         TEXT NOT NULL
                  CHECK (verdict IN ('pass','review','fail','no_face','skipped')),
  -- 'skipped' is deliberate and not a failure: a prompt the guard could not
  -- answer (phone in a pocket, hands full) must be visible as unanswered rather
  -- than silently absent or counted as a mismatch.

  -- Where the check happened.
  lat             DOUBLE PRECISION,
  lng             DOUBLE PRECISION,
  geo_ok          BOOLEAN,

  -- ── Manager review ──────────────────────────────────────────────────────
  -- Anything not 'pass' lands here. Never a lockout: see the header note.
  review_state    TEXT NOT NULL DEFAULT 'none'
                  CHECK (review_state IN ('none','pending','accepted','rejected')),
  reviewed_by     UUID REFERENCES app_users(id),
  reviewed_at     TIMESTAMPTZ,
  review_note     TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT guard_face_reviewed_has_reviewer CHECK (
    review_state IN ('none','pending') OR reviewed_by IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_face_shift ON guard_face_checks (shift_id);
-- The manager's queue. Partial — the overwhelming majority pass and never
-- appear here.
CREATE INDEX IF NOT EXISTS idx_face_review_queue
  ON guard_face_checks (city, captured_at) WHERE review_state = 'pending';
-- Retention sweep (45 days).
CREATE INDEX IF NOT EXISTS idx_face_age
  ON guard_face_checks (captured_at) WHERE selfie_path IS NOT NULL;

COMMENT ON TABLE guard_face_checks IS
  'Selfie verification events. Matching runs on the device; only score + verdict are uploaded.';
COMMENT ON COLUMN guard_face_checks.match_score IS
  'Raw on-device similarity. Stored alongside the verdict so a bad threshold can be re-evaluated retrospectively.';

-- ---------------------------------------------------------------------------
-- 3. Retention. 45 days attendance, 90 days item photos.
-- ---------------------------------------------------------------------------
-- The IMAGES are what expire; the records stay. An attendance row without its
-- selfie is still proof that someone checked in at a time and a place -- it just
-- can no longer be visually disputed. Deleting the row instead would erase the
-- attendance history itself.
--
-- Scheduled from Postgres, not Vercel: the two Vercel cron slots are taken by
-- reconcile and the digest, which is why 0018 and 0021 already moved scheduled
-- work here. The storage objects are removed by the route this calls; this
-- function only clears the references and reports what is now orphaned.
CREATE OR REPLACE FUNCTION public.expire_gate_media()
  RETURNS TABLE (kind text, cleared bigint)
  LANGUAGE plpgsql
AS $$
DECLARE n_face bigint; n_item bigint;
BEGIN
  UPDATE guard_face_checks
     SET selfie_path = NULL
   WHERE selfie_path IS NOT NULL
     AND captured_at < now() - INTERVAL '45 days';
  GET DIAGNOSTICS n_face = ROW_COUNT;

  UPDATE gate_scans
     SET photo_path = NULL
   WHERE photo_path IS NOT NULL
     AND scanned_at < now() - INTERVAL '90 days';
  GET DIAGNOSTICS n_item = ROW_COUNT;

  RETURN QUERY
    SELECT 'attendance_selfie'::text, n_face
    UNION ALL
    SELECT 'item_photo'::text, n_item;
END $$;

COMMENT ON FUNCTION public.expire_gate_media() IS
  'Clears expired media references: attendance selfies at 45 days, item photos at 90. Records are kept.';

-- ---------------------------------------------------------------------------
-- 4. RLS.
-- ---------------------------------------------------------------------------
ALTER TABLE guard_shifts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE guard_face_checks ENABLE ROW LEVEL SECURITY;

-- A guard sees their OWN attendance only. Their city's other guards' selfies are
-- none of their business -- this is the one place where city-wide read, the
-- pattern everywhere else in the schema, would be wrong.
DROP POLICY IF EXISTS guard_shifts_select ON guard_shifts;
CREATE POLICY guard_shifts_select ON guard_shifts
  FOR SELECT USING (
    public.auth_is_admin()
    OR (public.auth_role() = 'manager' AND city = public.auth_city())
    OR guard_id IN (SELECT id FROM app_users WHERE auth_id = auth.uid())
  );

DROP POLICY IF EXISTS guard_face_select ON guard_face_checks;
CREATE POLICY guard_face_select ON guard_face_checks
  FOR SELECT USING (
    public.auth_is_admin()
    OR (public.auth_role() = 'manager' AND city = public.auth_city())
    OR guard_id IN (SELECT id FROM app_users WHERE auth_id = auth.uid())
  );

-- A guard records their own attendance; supervisors do not fabricate it.
DROP POLICY IF EXISTS guard_shifts_insert ON guard_shifts;
CREATE POLICY guard_shifts_insert ON guard_shifts
  FOR INSERT WITH CHECK (
    guard_id IN (SELECT id FROM app_users WHERE auth_id = auth.uid())
  );

DROP POLICY IF EXISTS guard_face_insert ON guard_face_checks;
CREATE POLICY guard_face_insert ON guard_face_checks
  FOR INSERT WITH CHECK (
    guard_id IN (SELECT id FROM app_users WHERE auth_id = auth.uid())
  );

-- Check-out updates your own open shift; managers can correct and review.
DROP POLICY IF EXISTS guard_shifts_update ON guard_shifts;
CREATE POLICY guard_shifts_update ON guard_shifts
  FOR UPDATE USING (
    public.auth_is_admin()
    OR (public.auth_role() = 'manager' AND city = public.auth_city())
    OR guard_id IN (SELECT id FROM app_users WHERE auth_id = auth.uid())
  );

-- Reviewing a face check is supervisory only.
DROP POLICY IF EXISTS guard_face_update ON guard_face_checks;
CREATE POLICY guard_face_update ON guard_face_checks
  FOR UPDATE USING (
    public.auth_is_admin()
    OR (public.auth_role() = 'manager' AND city = public.auth_city())
  );
