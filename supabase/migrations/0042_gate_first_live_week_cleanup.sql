-- 0042_gate_first_live_week_cleanup.sql
--
-- Undo two kinds of wrong data written during Delhi's first live days
-- (11–14 Sep 2026). Only derived or phantom values are touched — nothing a
-- guard recorded, and nothing the reconciliation reads.
--
-- 1. PHOTOS THAT WERE NEVER TAKEN.
--    The server used to pick a random 10% of outward scans for a photo AFTER
--    the scan, and record a photo path for them — but nothing on the phone was
--    ever asked to take one. Measured 14 Sep: 16 of 16 such rows had a path and
--    no file, and each showed a manager a camera icon leading to "missing".
--    The sampling is removed in code (lib/gate/sync.ts). Here the phantom paths
--    are cleared, so those rows stop claiming evidence that does not exist.
--
--    Narrow on purpose: scans only, no override, and only where storage really
--    has no file. A HAND entry's missing photo is NOT cleared — that photo was
--    taken and lost, and "recorded but missing" is the truth about it.
--
-- 2. DT TASK DETAILS MATCHED THE WRONG WAY.
--    The first matching rule accepted a task of the "other" kind. For units
--    leaving in the morning that meant the pickup that brought them back — the
--    previous customer — because DT only records which barcode went on a
--    delivery once the agent completes it. 46 outward rows on 13–14 Sep carried
--    a pickup, repair or replace task as a match. The rule is now strict about
--    direction (lib/gate/enrich.ts, taskForScan); here every stored task lookup
--    is cleared so the scheduled job and the portal recompute them under it.
--    Recomputing is a few seconds of DT and Odoo queries per trip.
--
-- Safe to re-run.

UPDATE gate_scans s
   SET photo_path = NULL, photo_sampled = false
 WHERE s.photo_path IS NOT NULL
   AND s.entry_method = 'scan'
   AND s.override_reason IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM storage.objects o
      WHERE o.bucket_id = 'gate-evidence' AND o.name = s.photo_path
   );

UPDATE gate_scans
   SET task_ticket = NULL, task_job_type = NULL, task_customer = NULL,
       task_so = NULL, task_city = NULL, task_date = NULL,
       task_matched = NULL, task_checked_at = NULL
 WHERE task_checked_at IS NOT NULL
    OR task_matched IS NOT NULL
    OR task_ticket IS NOT NULL;
