-- 0040_gate_task_match_by_date.sql
--
-- Attach a DT task to a gate scan only when the task IS that movement.
--
-- THE MISTAKE 0039 SHIPPED WITH. The lookup attached each unit's most recent
-- DT task, however old. The first trip anybody opened showed FUL5ZA24120009,
-- scanned inward at Delhi on 11 Sep 2026, as "Pickup and Refund, CHARUVI
-- AGARWAL, ticket 1099165" — a pickup from 8 March 2026, two movements ago.
-- Odoo shows the unit left Gurgaon on an internal transfer on 22 March, which
-- has no DT task, and nothing at all for September. The honest row is blank.
--
-- The code now matches a task to the scan by date (lib/gate/enrich.ts,
-- taskForScan). This migration:
--   1. adds task_date and task_matched. With no task near the scan date the
--      unit's latest task is still shown (business decision, 11 Sep 2026) —
--      but flagged task_matched = false and labelled "last known · <date>" on
--      screen and in the download, so it is never mistaken for this movement;
--   2. clears every task lookup made under the old rule, so those rows are
--      asked again under the new one. Only the derived task_* columns are
--      touched; nothing the guard recorded, nothing the reconciliation reads.
--
-- Safe to re-run: the reset only clears rows that have no task_date, which is
-- every row the old rule wrote and none the new rule writes with a match.

ALTER TABLE gate_scans
  ADD COLUMN IF NOT EXISTS task_date    DATE,
  -- true  = the task IS this movement (scheduled within a few days of the scan)
  -- false = no such task; the unit's LATEST task is shown, labelled last known
  -- null  = nothing attached
  ADD COLUMN IF NOT EXISTS task_matched BOOLEAN;

COMMENT ON COLUMN gate_scans.task_date IS
  'IST date the attached DT task was scheduled for — this movement''s task when '
  'task_matched, otherwise the unit''s latest task.';

UPDATE gate_scans
   SET task_ticket = NULL, task_job_type = NULL, task_customer = NULL,
       task_so = NULL, task_city = NULL, task_checked_at = NULL
 WHERE task_checked_at IS NOT NULL
   AND task_date IS NULL;
