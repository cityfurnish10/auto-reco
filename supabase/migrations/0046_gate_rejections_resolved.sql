-- 0046_gate_rejections_resolved.sql
--
-- A refused entry that has since been accepted stops being outstanding.
--
-- WHY. gate_sync_rejections is written when the database refuses a row, and
-- nothing ever cleared it — so the Gate screen's "Refused items" counted every
-- refusal in the system's history. On 15 Sep 2026 it read 17: ten hand-added
-- outward items refused before 0041 narrowed that rule, and seven test rows
-- from 26 August. A to-do list that only grows stops being read.
--
-- A refusal is resolved when the SAME entry (client_id) is later stored — which
-- is exactly what "Try again" on the phone does. The sync marks it at that
-- moment (lib/gate/sync.ts); this backfills everything already accepted.
--
-- The rows are kept, not deleted: that a row was once refused is part of how
-- the gate behaved, and the tab can still show resolved ones on request.
--
-- Safe to re-run.

ALTER TABLE gate_sync_rejections
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

COMMENT ON COLUMN gate_sync_rejections.resolved_at IS
  'When the same entry was accepted after all (the guard retried). Null = still '
  'outstanding: the movement is on a phone and not in the record.';

CREATE INDEX IF NOT EXISTS gate_sync_rejections_open_idx
  ON gate_sync_rejections (city, rejected_at DESC) WHERE resolved_at IS NULL;

-- Backfill: anything whose entry now exists.
UPDATE gate_sync_rejections r
   SET resolved_at = now()
 WHERE r.resolved_at IS NULL
   AND (
     (r.kind = 'scan'  AND EXISTS (SELECT 1 FROM gate_scans s        WHERE s.client_scan_id  = r.client_id))
  OR (r.kind = 'trip'  AND EXISTS (SELECT 1 FROM gate_trips t        WHERE t.client_trip_id  = r.client_id))
  OR (r.kind = 'shift' AND EXISTS (SELECT 1 FROM guard_shifts g      WHERE g.client_shift_id = r.client_id))
  OR (r.kind = 'face'  AND EXISTS (SELECT 1 FROM guard_face_checks f WHERE f.client_check_id = r.client_id))
   );
