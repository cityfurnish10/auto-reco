-- 0043_gate_redo_task_lookups_odoo_first.sql
--
-- Clear stored order/ticket lookups so they are redone Odoo-first.
--
-- The lookup now takes the ORDER from Odoo — the In Transit line the warehouse
-- marks before loading (outward), or the last delivery the unit went out on
-- (inward) — and only the ticket and job type from DT. Replayed on every live
-- Delhi scan from 13–14 Sep 2026: 177 of 189 outward and 24 of 26 inward rows
-- get customer, SO and ticket, against DT's doorstep links agreeing 127 of 131
-- times. Rows already looked up under the DT-first rule would otherwise keep
-- its answer, which named the previous customer on outward trips.
--
-- Only the derived task_* columns are touched. Recomputed by the scheduled job
-- and whenever a manager opens a trip; ~2 seconds for a day's scans.
--
-- Safe to re-run.

UPDATE gate_scans
   SET task_ticket = NULL, task_job_type = NULL, task_customer = NULL,
       task_so = NULL, task_city = NULL, task_date = NULL,
       task_matched = NULL, task_checked_at = NULL
 WHERE task_checked_at IS NOT NULL
    OR task_matched IS NOT NULL
    OR task_ticket IS NOT NULL;
