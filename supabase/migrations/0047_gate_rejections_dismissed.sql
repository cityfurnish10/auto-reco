-- 0047_gate_rejections_dismissed.sql
--
-- A refusal that will never be retried can be closed by a manager.
--
-- WHY. 0046 made refused items a to-do list: outstanding until the SAME entry
-- is later accepted, which is what "Try again" on the phone does. That covers
-- every refusal a guard can still fix, and it leaves a residue that no phone
-- can ever clear. Measured 15 Sep 2026, three of the thirteen outstanding rows
-- are refusals from 26 August reading "unknown trip" — the trip they belonged
-- to does not exist, so a retry produces the identical refusal forever. They
-- were test rows. A to-do list carrying items nobody can complete is a list
-- people stop reading, which is how the count reached 17 before anyone looked.
--
-- So a manager gets the other ending: not "it was accepted after all" but "this
-- is never coming, and here is why". The two are deliberately different columns
-- and read differently on screen — an entry a human wrote off is not evidence
-- that the movement was recorded, and collapsing them into one "done" state
-- would let a dismissal be mistaken for a retry that worked.
--
-- The rows are kept, as in 0046. That a movement was refused and then written
-- off is exactly the sort of thing an audit asks about, and the reason is
-- stored so the answer does not depend on somebody remembering.
--
-- Reversible on purpose: dismissed_at is cleared by the Undo on the same
-- screen. A mis-click must not permanently bury a real missing movement.
--
-- Safe to re-run.

ALTER TABLE gate_sync_rejections
  ADD COLUMN IF NOT EXISTS dismissed_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dismissed_by     UUID REFERENCES app_users(id),
  ADD COLUMN IF NOT EXISTS dismiss_reason   TEXT,
  ADD COLUMN IF NOT EXISTS dismiss_note     TEXT;

COMMENT ON COLUMN gate_sync_rejections.dismissed_at IS
  'When a manager wrote this refusal off as never coming. NOT the same as '
  'resolved_at: resolved means the entry was later accepted, dismissed means a '
  'human decided it never will be. Null = still outstanding.';
COMMENT ON COLUMN gate_sync_rejections.dismiss_reason IS
  'Why it was written off — one of a short fixed list, so the residue can be '
  'counted by cause rather than read one row at a time.';

-- The outstanding list, which is now "neither accepted nor written off".
-- Replaces the 0046 index, whose WHERE clause no longer matches the query.
DROP INDEX IF EXISTS gate_sync_rejections_open_idx;
CREATE INDEX IF NOT EXISTS gate_sync_rejections_open_idx
  ON gate_sync_rejections (city, rejected_at DESC)
  WHERE resolved_at IS NULL AND dismissed_at IS NULL;
