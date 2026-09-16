-- 0048_sheet_not_done_counts.sql
--
-- Why the dashboard's sheet column is smaller than the sheet.
--
-- WHAT HAPPENED. On 15 Sep 2026 the owner counted the Delhi outward tab for
-- business day 14: 91 rows, 87 of them with barcodes. The scoreboard said 78,
-- and nothing on the screen could explain the gap — which reads as a stale or
-- broken figure.
--
-- It was neither. Fifteen of those rows say "Not Delivered" in the sheet's own
-- outcome column. A failed delivery is not a movement, and counting one would
-- seed a dispatch to chase that never happened, so the pipeline removes them
-- (run.ts). Six were claimed complete by another book and kept — done wins
-- across sources — leaving nine removed. 91 rows − 9 not delivered − 4 PP box
-- lines counted separately = 78.
--
-- Every step of that is correct and none of it was visible. These columns make
-- the subtraction showable, so a number on the dashboard can be tied back to
-- the sheet somebody is holding.
--
-- TWO PAIRS, because they answer different questions:
--   *_not_done   what somebody reading the sheet counts (15)
--   *_dropped    how many were actually removed (9)
-- They differ exactly when the sheet is out of step with the other books, which
-- is itself worth being able to see.
--
-- Only the sheet carries an outcome (invariant 3) — DT, Odoo and the gate
-- register all hard-code "done" because each filters to completed rows
-- upstream. So there is no equivalent for the other three sources, and columns
-- for them would be permanently zero.
--
-- Existing rows keep 0. They pre-date the columns, so a date reconciled before
-- today simply shows no breakdown rather than claiming nothing was dropped.
--
-- Safe to re-run. Additive only.

ALTER TABLE public.run_city_stats
  ADD COLUMN IF NOT EXISTS sheet_not_done_in  INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sheet_not_done_out INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sheet_dropped_in   INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sheet_dropped_out  INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.run_city_stats.sheet_not_done_out IS
  'Outward sheet rows whose own outcome column says the task did not happen. '
  'What a person counting the sheet sees.';
COMMENT ON COLUMN public.run_city_stats.sheet_dropped_out IS
  'How many of those were actually removed from reconciliation. Smaller than '
  'sheet_not_done_out whenever another book says the movement completed.';
