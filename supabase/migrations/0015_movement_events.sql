-- A ledger of every movement, clean or not.
--
-- WHY: nothing in this database records a movement that went RIGHT.
-- lib/engine/ladder.ts returns null for a reconciled unit, and run.ts only
-- pushes a row when classify() returns a hit, so `variances` is a record of
-- problems. The single surviving trace of a clean movement is the integer
-- run_city_stats.movements. source_rows holds the raw feed but is pruned after
-- 7 days.
--
-- Measured 2026-07-29: source_rows retained 6 business dates (72,269 rows);
-- variances held 14 days across 4,899 distinct barcodes, of which 2,733 appear
-- on exactly ONE day and only 589 on three or more. So for the large majority
-- of units the useful question -- "was this unit fine on the other days?" --
-- has no answer anywhere. A barcode's history today is a list of its problems,
-- not its movements.
--
-- This table answers it: one row per canonical barcode per direction per
-- business date, whatever the outcome, retained long-term.
--
-- IT ONLY ACCRUES FORWARD. Nothing older than the source_rows window can be
-- reconstructed -- see the BACKFILL note at the foot of this file. The ledger
-- is worth exactly as much as the number of days it has been running, which is
-- why it ships before the feature that reads it.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS public.movement_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- SET NULL, deliberately NOT CASCADE. prune_expired() deletes failed runs
  -- after 30 days, and upsertMovementEvents re-stamps run_id to the newest run
  -- that saw the unit -- exactly as variances.run_id behaves. With CASCADE, one
  -- run that wrote rows and then failed would silently take a slice of the
  -- ledger with it a month later. run_id here means "the last run that touched
  -- this row", never a historical pointer.
  run_id         UUID REFERENCES public.reconciliation_runs(id) ON DELETE SET NULL,

  business_date  DATE NOT NULL,
  city           TEXT NOT NULL
                 CHECK (city IN ('DELHI','MUMBAI','PUNE','HYDERABAD','BANGALORE')),
  -- IN | OUT only. A direction-conflict (CROSS) variance has no view of its
  -- own -- it spans an IN leg and an OUT leg -- so it is recorded against BOTH.
  direction      TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  -- CANONICAL, like variances.barcode. Never the raw spelling; see 0014.
  barcode        TEXT NOT NULL,

  -- Which sources CONFIRMED this unit. Read at EMIT time, after the OCR-orphan
  -- fold has run: mergeGuardPresence (lib/engine/views.ts) MUTATES target.P
  -- after the views are built, so a snapshot taken during buildViews reports
  -- "no gate record" for exactly the units the merge just fixed. Same trap
  -- 0013 documents; the ledger reads presenceOf(v) at the end of the run.
  present_p  BOOLEAN NOT NULL DEFAULT FALSE,
  present_s  BOOLEAN NOT NULL DEFAULT FALSE,
  present_d  BOOLEAN NOT NULL DEFAULT FALSE,
  present_o  BOOLEAN NOT NULL DEFAULT FALSE,

  -- Which sources REPORTED for this city+run at all. Same argument as 0012 and
  -- 0013: a source that was DOWN must not read as an absence it never had the
  -- chance to fill. Held per-row rather than joined from run_city_stats, which
  -- is upserted on (business_date, city) and would be rewritten underneath
  -- these rows by a later partial re-run.
  reported_p BOOLEAN NOT NULL DEFAULT FALSE,
  reported_s BOOLEAN NOT NULL DEFAULT FALSE,
  reported_d BOOLEAN NOT NULL DEFAULT FALSE,
  reported_o BOOLEAN NOT NULL DEFAULT FALSE,

  -- The Odoo timing flags the ladder branches on. Without them a stored row
  -- cannot explain why an Odoo-present unit was still a problem, and
  -- odoo_same_day is part of is_movement below.
  odoo_same_day      BOOLEAN NOT NULL DEFAULT FALSE,
  odoo_next_day      BOOLEAN NOT NULL DEFAULT FALSE,
  odoo_created_today BOOLEAN NOT NULL DEFAULT FALSE,

  -- run.ts's own isMovement: P || S || D || odooSameDay. Stored rather than
  -- derived so count(*) FILTER (WHERE is_movement) can be checked against
  -- run_city_stats.movements for the date and any drift becomes visible.
  -- A view whose ONLY evidence is an adjacent-day Odoo posting is a
  -- match-target, not a movement -- counting those once inflated a city's
  -- denominator tenfold.
  is_movement BOOLEAN NOT NULL DEFAULT FALSE,

  job_type   TEXT,
  so_number  TEXT,
  ticket_id  TEXT,
  customer   TEXT,
  product    TEXT,

  -- CLEAN is the row this table exists for. SUPPRESSED means the engine saw the
  -- unit and deliberately said nothing (Section 7) -- which is different from
  -- clean, and different again from never having been seen.
  outcome    TEXT NOT NULL DEFAULT 'CLEAN'
             CHECK (outcome IN ('CLEAN','INFO','REAL','SUPPRESSED')),

  -- DENORMALISED, not a foreign key to variances.id, for three reasons:
  --   * one (date, city, direction, barcode) can raise MORE than one variance
  --     -- classifyViews pushes the ladder hit AND a duplicate-scan hit;
  --   * resolveStaleOpenVariances DELETEs superseded rows, which would either
  --     cascade-null this column or block the delete;
  --   * prune_expired() removes closed variances after 90 days, and this table
  --     is long-term by definition.
  variance_names TEXT[] NOT NULL DEFAULT '{}',
  worst_priority TEXT
                 CHECK (worst_priority IS NULL OR worst_priority IN ('High','Medium','Info')),
  suppressed_reason TEXT
                 CHECK (suppressed_reason IS NULL OR suppressed_reason IN
                        ('dt_all_pending','silent_ocr','failed_delivery_return','other')),

  -- TRUE for rows written by scripts/backfill-movement-events.mjs rather than by
  -- the nightly run. A backfill re-reads the LIVE sources, so it reports what is
  -- true about that night NOW -- Odoo postings added since, DT statuses changed,
  -- the ops sheet edited. It is a reconstruction, not a recording, and without
  -- this flag the ledger would quietly overstate historical accuracy.
  backfilled BOOLEAN NOT NULL DEFAULT FALSE,

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Natural key. Mirrors variances, which upserts on its natural key -- NOT
  -- source_rows, which plain-inserts and therefore keeps every re-check pass
  -- (measured: 4,106 stored rows for a date whose run pulled 896). A re-run
  -- must update this row, never add a second one.
  UNIQUE (business_date, city, direction, barcode)
);

-- THE index. "Every day this unit appears" is the question the table exists to
-- answer, and variances had no barcode-leading index until 0014.
CREATE INDEX IF NOT EXISTS idx_me_barcode
  ON public.movement_events (barcode, business_date DESC);
CREATE INDEX IF NOT EXISTS idx_me_date_city
  ON public.movement_events (business_date, city);
CREATE INDEX IF NOT EXISTS idx_me_run
  ON public.movement_events (run_id);
-- Repeat offenders: units flagged on N distinct days. Partial, because the
-- CLEAN rows are the bulk of the table and never match this predicate.
CREATE INDEX IF NOT EXISTS idx_me_problem
  ON public.movement_events (barcode, business_date DESC)
  WHERE outcome IN ('REAL','INFO');

-- RLS. NOT optional and not cosmetic: without it a city manager reads every
-- city's movement history. Same predicate as source_rows / variances /
-- run_city_stats (0004, 0005). SELECT only -- writes go through the
-- service-role client in the pipeline, which bypasses RLS.
ALTER TABLE public.movement_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS movement_events_select ON public.movement_events;
CREATE POLICY movement_events_select ON public.movement_events
  FOR SELECT USING (public.auth_is_admin() OR city = public.auth_city());

COMMENT ON TABLE public.movement_events IS
  'One row per canonical barcode per direction per business date -- CLEAN or not. Retained long-term: deliberately NOT in prune_expired(). Rows exist only for units that reached the ladder, so spares, PP boxes and invalid barcodes never appear (they are the count-only layer); an OCR orphan folded by mergeOcrOrphans appears once under the TARGET canonical; digits-only fragments dropped by dropOcrFragments do not appear at all. Do not reconcile row counts against source_rows without accounting for those three.';

-- ---------------------------------------------------------------------------
-- RETENTION: none, deliberately.
--
-- ~1,100 movements/day across five cities plus suppressed and non-movement
-- views, so roughly 1,100-1,400 rows/day, ~450k/year. For scale, source_rows
-- writes ~12,000 rows/day: eleven days of ledger costs what one day of raw feed
-- costs. Long retention is the entire point of the table, and capping it before
-- anyone knows how it is queried is how you lose the data you built it for.
--
-- If a cap is ever wanted, CREATE OR REPLACE the whole prune_expired() function
-- (defined in 0001 section 7) with an added:
--   DELETE FROM movement_events WHERE business_date < CURRENT_DATE - INTERVAL '24 months';
-- and note that 0001's copy of the definition then becomes stale.
--
-- ---------------------------------------------------------------------------
-- BACKFILL: six days at most, and it is a reconstruction.
--
-- Recoverable by re-running the engine over the retained source_rows window.
-- NOT recoverable by any SQL over stored rows, for the reasons 0013's header
-- sets out: mergeOcrOrphans folds one canonical's guard presence into a
-- DIFFERENT canonical, dropOcrFragments deletes views outright, and the Odoo
-- +/-1 day window plus the same_day/next_day/created_today composite is
-- per-city logic, not a query.
--
-- Use scripts/backfill-movement-events.mjs, which calls the engine but writes
-- ONLY this table. It must not call saveSourceRows (plain-inserts, would double
-- the raw feed), resolveStaleOpenVariances (DELETEs superseded rows and
-- rewrites open ones a manager may be mid-triage on), or saveCityStats
-- (overwrites the day's leaderboard numbers with today's re-pull).
--
-- Rows it writes carry backfilled = TRUE. Nothing older than the source_rows
-- window exists at all; the ledger simply starts the day this is applied.
