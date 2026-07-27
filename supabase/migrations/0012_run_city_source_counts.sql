-- Per-city, per-source, per-direction movement counts on run_city_stats.
--
-- WHY: the daily digest is to carry a Movement Summary table — Register / Odoo
-- / Delivery Tracker / Security Guards, each Out and In, per city. The engine
-- ALREADY computes exactly these numbers (computeCountLayer, once for IN and
-- once for OUT) and then throws them away: CityRunResult.count_in / count_out
-- reach nothing outside a single test. This gives them somewhere to live.
--
-- All three email send paths build from the DATABASE (buildDigestFromDb), not
-- from a live run, so the counts have to be persisted rather than passed in
-- memory. source_rows cannot stand in — it is pruned after 7 days, so a re-send
-- of an older date would find nothing.
--
-- The reported_* booleans are not redundant with the counts. A zero count
-- cannot distinguish "the connector was down" from "there genuinely were no
-- movements", and the email must not say the wrong one.
--
-- Safe to re-run. Additive only; nothing existing changes.

ALTER TABLE public.run_city_stats
  -- SHEET = the ops "Register" column in the summary table
  ADD COLUMN IF NOT EXISTS sheet_in    INT  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sheet_out   INT  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS odoo_in     INT  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS odoo_out    INT  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dt_in       INT  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dt_out      INT  NOT NULL DEFAULT 0,
  -- PHYSICAL = the guard register ("Security Guards" column)
  ADD COLUMN IF NOT EXISTS phys_in     INT  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS phys_out    INT  NOT NULL DEFAULT 0,
  -- Did each connector actually report for this city on this date?
  ADD COLUMN IF NOT EXISTS reported_p  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reported_s  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reported_d  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reported_o  BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.run_city_stats.sheet_in IS
  'Ops-sheet inward rows that entered reconciliation (excludes PP boxes, spares and invalid barcodes).';
COMMENT ON COLUMN public.run_city_stats.reported_p IS
  'Guard-register connector succeeded AND returned >=1 row for this city. FALSE with a 0 count means the source did not report, not that nothing moved.';

-- Existing rows keep 0/FALSE. They pre-date the columns, so the digest treats a
-- run with every reported_* false and every count 0 as "counts unavailable for
-- this date" rather than "all four sources were down".
