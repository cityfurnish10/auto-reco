-- 0027_gate_sign_ins.sql
--
-- Who signed in on which phone, and when.
--
-- WHY IT IS NOT ALREADY ANSWERABLE. guard_shifts records a CHECK-IN, which is a
-- different event: a guard can open the app, enter their PIN and scan without
-- ever checking in, and a failed PIN leaves no trace at all. So "who has used
-- this phone?" and "has anyone been trying PINs on it?" were both unanswerable.
--
-- Failures are recorded as well as successes, and deliberately: a run of wrong
-- PINs on one device is the only signal that anyone is trying phones that are
-- not theirs, and it is worthless if only the successes are kept.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS gate_sign_ins (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    TEXT NOT NULL,
  city         TEXT NOT NULL
               CHECK (city IN ('DELHI','MUMBAI','PUNE','HYDERABAD','BANGALORE')),
  -- Null on a failed attempt where the guard could not even be identified.
  guard_id     UUID REFERENCES app_users(id) ON DELETE SET NULL,
  ok           BOOLEAN NOT NULL,
  -- 'wrong_pin' | 'not_at_this_gate' | 'inactive' — why it was refused.
  reason       TEXT,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Coarse only. Enough to spot an unfamiliar handset, never a fingerprint.
  user_agent   TEXT
);

CREATE INDEX IF NOT EXISTS idx_signin_device ON gate_sign_ins (device_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_signin_city   ON gate_sign_ins (city, at DESC);
-- The one that matters for spotting trouble: failures, newest first.
CREATE INDEX IF NOT EXISTS idx_signin_failed ON gate_sign_ins (city, at DESC) WHERE NOT ok;

COMMENT ON TABLE gate_sign_ins IS
  'Every PIN attempt at a gate, successful or not. Distinct from guard_shifts, which records attendance.';

ALTER TABLE gate_sign_ins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gate_sign_ins_select ON gate_sign_ins;
CREATE POLICY gate_sign_ins_select ON gate_sign_ins
  FOR SELECT USING (public.auth_is_admin() OR city = public.auth_city());
