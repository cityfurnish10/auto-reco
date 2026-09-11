-- 0039_gate_scan_task_details.sql
--
-- Ticket, job type and customer for a gate scan, from the Delivery Tracker.
--
-- WHY. A manager opening a trip needs the row the paper register used to hold:
-- city, SO, ticket, customer, job type, item, direction, barcode, agent, truck.
-- 0037 covered what Odoo knows about a serial (product, last SO, last partner),
-- but the TICKET and the JOB TYPE ("Pickup and Refund", "Delivery", …) exist
-- only in DT — Odoo's "reference" is its own transfer number, not a ticket.
-- And Odoo's partner is often a vendor or an internal account, while DT holds
-- the actual customer the task was for.
--
-- WHAT IS STORED. The unit's most recent DT task, regardless of status. For a
-- unit at the gate right now that is usually today's task — which makes these
-- columns closer to the plan than 0037's were, and that is accepted on two
-- conditions that hold by construction:
--   * the GUARD never sees them (the phone has no read path to gate_scans), and
--   * the RECONCILIATION never reads them. lib/connectors/guard.ts reads
--     product / so_number / ticket_id / customer — the gate's own testimony —
--     and none of the columns below. Same separation 0037 relies on.
--
-- A separate "checked" stamp rather than reusing enriched_at: every scan
-- recorded before this migration already carries enriched_at from the Odoo
-- pass, and reusing it would mean none of them ever got a ticket.
--
-- Measured before writing this (2026-09-11): one DT query for a batch of
-- serials returns in ~0.8s, and FUL5ZA24120009 came back as ticket 1099165,
-- "Pickup and Refund", customer CHARUVI AGARWAL, Gurgaon.
--
-- Safe to re-run.

ALTER TABLE gate_scans
  ADD COLUMN IF NOT EXISTS task_ticket     TEXT,
  ADD COLUMN IF NOT EXISTS task_job_type   TEXT,
  ADD COLUMN IF NOT EXISTS task_customer   TEXT,
  ADD COLUMN IF NOT EXISTS task_so         TEXT,
  ADD COLUMN IF NOT EXISTS task_city       TEXT,
  -- Null = never asked. Set even when DT has never heard of the serial (vendor
  -- stock that has not been out to a customer yet), so it is not re-asked forever.
  ADD COLUMN IF NOT EXISTS task_checked_at TIMESTAMPTZ;

COMMENT ON COLUMN gate_scans.task_ticket IS
  'DT ticket of this unit''s most recent task. Looked up by serial after the '
  'scan; shown to managers only and never read by the reconciliation.';
COMMENT ON COLUMN gate_scans.task_checked_at IS
  'When the DT lookup last ran for this row. Set even on a miss.';

CREATE INDEX IF NOT EXISTS gate_scans_task_unchecked_idx
  ON gate_scans (scanned_at)
  WHERE task_checked_at IS NULL;
