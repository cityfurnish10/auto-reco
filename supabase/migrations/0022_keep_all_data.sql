-- 0022_keep_all_data.sql
--
-- Stop deleting history. prune_expired() becomes a no-op.
--
-- WHAT IT USED TO DELETE (0001_init.sql:227-246), called at the end of EVERY
-- pipeline run, about seven times a day:
--
--   source_rows          business_date < CURRENT_DATE - 7 days
--   variances            status='closed' AND closed_at < now() - 90 days
--   reconciliation_runs  status='failed'  AND created_at < now() - 30 days
--
-- WHY ALL THREE GO, not just the seven-day one.
--
--   source_rows is the owner's actual request, and it is the one that hurt:
--   measured 2026-08-10, 13,492 of 17,895 open variances had a business_date
--   older than the oldest retained raw feed, so no re-run could ever look at
--   them again. That is why the settle sweep had to invent an "Aged out --
--   source data expired" closure at all. With the raw feed kept, every date
--   stays re-runnable forever and that whole category stops being created.
--
--   The failed-run delete is worse than it looks. variances.run_id is
--   ON DELETE CASCADE (0001_init.sql:112), so deleting a run deletes ITS
--   VARIANCES -- and source_rows.run_id cascades too. Meanwhile saveCityStats,
--   saveIngestionLogs and finalizeRun run AFTER variances are committed and are
--   unguarded, so a throw in any of them flips a fully successful reconcile to
--   'failed'. That combination silently destroys a good day's findings thirty
--   days later. Removing the delete closes the path without touching the
--   cascade.
--
--   The closed-variance delete would, ninety days from 2026-08-10, erase the
--   10,965 rows the settle sweep has just closed -- the audit trail for the
--   single largest bulk decision ever made in this system.
--
-- WHAT THIS COSTS. ~800 bytes of JSON per source row, ~1.6 KB on disk with
-- indexes. A deduplicated feed is ~2,786 rows/day = ~1.6 GB/year. Supabase Pro
-- includes 8 GB. The duplication fix in saveSourceRows must ship WITH this
-- migration: without it the feed stores ~15,521 rows/day = ~8.9 GB/year, which
-- exhausts the plan inside a year.
--
-- THE FUNCTION IS KEPT, not dropped. lib/reconcile/pipeline.ts calls
-- prune_expired() at the end of every run and a deploy can precede its
-- migration in this project, so removing it would throw on a live path. It is
-- redefined to do nothing, which makes an unapplied 0022 and an applied one
-- behave identically apart from the deletes themselves.
--
-- Safe to re-run.

CREATE OR REPLACE FUNCTION prune_expired()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- Deliberately empty. History is retained in full; see 0022 for the reasoning.
  --
  -- If retention is ever needed again, add it here rather than at a call site:
  -- this function is the one thing every pipeline run already invokes, and the
  -- reason a retention rule can be changed without redeploying the app.
  RETURN;
END;
$$;

COMMENT ON FUNCTION prune_expired() IS
  'No-op since 0022. Retention was: source_rows 7d, closed variances 90d, failed runs 30d. All history is now kept -- the raw feed is what makes a past date re-runnable, and variances.run_id ON DELETE CASCADE made the failed-run rule a silent data-loss path.';

COMMENT ON TABLE source_rows IS
  'Raw rows pulled from all 4 connectors. Retained permanently since 0022 (previously 7 days). saveSourceRows keeps ONE copy per (business_date, source): it inserts the fresh pull, then deletes older runs'' rows for the same date and source, so the ~7 runs a day no longer store ~7 copies. Genuine duplicate scans WITHIN a pull are preserved -- they are a reported variance.';


-- ---------------------------------------------------------------------------
-- One-off: collapse the duplication already stored.
-- ---------------------------------------------------------------------------
--
-- Keeps, per (business_date, source), only the rows belonging to the newest run
-- that stored any rows for that pair. Newest rather than first because later
-- runs see strictly more: on 2026-08-05 the seven stored runs held 3,203 /
-- 3,203 / 2,646 / 2,645 / 2,645 / 2,015 / 1,073 rows as Odoo postings and ops
-- sheet lines arrived through the day.
--
-- Verified before writing: the two largest runs for that date were byte
-- identical across all four sources (558/620/453/1572 rows each, zero
-- differences), so this discards copies, never content.

WITH newest AS (
  SELECT DISTINCT ON (business_date, source)
         business_date, source, run_id
    FROM source_rows
   ORDER BY business_date, source, created_at DESC
)
DELETE FROM source_rows s
 USING newest n
 WHERE s.business_date = n.business_date
   AND s.source        = n.source
   AND s.run_id       <> n.run_id;


-- ---------------------------------------------------------------------------
-- Index for the new access pattern.
-- ---------------------------------------------------------------------------
--
-- saveSourceRows now deletes on (business_date, source, run_id) after every
-- pull, and the table is no longer bounded at seven days. idx_sr_source is
-- (source, business_date) -- leading with the low-cardinality column, so it
-- cannot serve a single-date delete well. This one matches the predicate.
CREATE INDEX IF NOT EXISTS idx_sr_date_source_run
  ON source_rows (business_date, source, run_id);
