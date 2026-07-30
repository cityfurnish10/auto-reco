-- What each RUN concluded about each CITY, and how much of the day it could see.
--
-- WHY: there is currently no per-run record of anything per city.
--
-- A single business date measures between 1 and 7 usable runs. Two runs of the
-- SAME date (2026-07-26) returned real=101 and real=26. That looks like 75 items
-- resolved. It was not: the second run was status='partial'. The delta was
-- SOURCE COVERAGE, not resolution. 2026-07-25 swings 237 -> 422 -> 397 across
-- three runs. Nothing in this database can currently tell those two stories
-- apart, and every existing artefact fails for a different reason:
--
--   * variances is UPSERTed on (business_date, city, direction, barcode,
--     variance_name) and RE-STAMPS run_id to the newest run (persist.ts). The
--     first run's verdict is not versioned; it is destroyed. Worse,
--     `WHERE run_id = <first run>` still returns rows -- the residue the second
--     run neither re-emitted nor resolved -- so the wrong query looks right.
--
--   * run_city_stats is UPSERTed on (business_date, city). 0005's header wants
--     exactly that, so leaderboard windows never double-count a re-run. The
--     re-check pass therefore OVERWRITES the numbers the primary pass produced.
--     There is no run dimension in that table at all.
--
--   * movement_events (0015) is UPSERTed on its natural key and its run_id means
--     "the last run that touched this row". Correct for a physical ledger,
--     worthless as run history -- which is why this table exists rather than a
--     column there.
--
--   * reconciliation_runs IS insert-per-run and does survive, but finalizeRun
--     writes total / real_count / info_count / high_priority / by_variance:
--     GLOBAL across all five cities, and BUCKET-level (REAL/INFO). This page
--     needs per-CITY and TIER-level, and tiers deliberately re-cut buckets
--     (lib/ui/variance-labels.ts). Neither number is the other.
--
--   * resolveStaleOpenVariances hard-DELETEs superseded rows. No tombstone.
--     After it runs, the evidence that a unit was ever flagged under its old
--     name is gone from every table.
--
-- Same argument 0012, 0013 and 0016 each made in turn: every display path reads
-- the DATABASE, so the answer is written down by the code that produced it, at
-- the moment it produced it. It is not recomputed, because it cannot be.
--
-- IT ONLY ACCRUES FORWARD. See the BACKFILL note at the foot.
--
-- Safe to re-run. Additive only; nothing existing changes.


-- ---------------------------------------------------------------------------
-- A) reconciliation_runs: which pass was this?
--
-- Nothing currently marks a run as the re-check. The re-check pass writes
-- trigger:'cron', byte-identical to the primary pass
-- (app/api/cron/reconcile/route.ts). "First reconciliation vs re-check" -- the
-- whole first question -- is therefore unanswerable today.
--
-- A NEW COLUMN, NOT A WIDENED `trigger`. `trigger` means WHO STARTED IT (cron
-- vs a human's POST) and is filtered on elsewhere; run_role means WHICH PASS.
-- They are orthogonal: an admin POSTing a targeted re-run is trigger='manual',
-- run_role='adhoc', and a re-check is trigger='cron', run_role='recheck'.
-- Folding them into one column loses one of the two facts, permanently.
--
-- DEFAULT 'unknown', NOT 'primary'. Every run written before this migration is
-- of unknown role and cannot be inferred: trigger='cron' is identical for both
-- passes. A heuristic on (created_at - business_date) is right most of the time
-- and wrong exactly where it matters -- a late-firing cron, a manual re-run, the
-- 2026-07-20 row still stranded at status='running'. Defaulting to 'primary'
-- would make every historic run assert something false. 'unknown' asserts what
-- is true, and the UI has to handle it.
--
-- New rows never get 'unknown': createRun's `role` option is REQUIRED in
-- TypeScript, not optional, so `tsc --noEmit` fails at any call site that has
-- not decided. Same device as VarianceRowOut.present and saveEmailLog.totals.

ALTER TABLE public.reconciliation_runs
  ADD COLUMN IF NOT EXISTS run_role TEXT NOT NULL DEFAULT 'unknown',
  -- The re-check pass sets skipOcr and that fact has never reached the database.
  -- It matters here: skipping OCR means the guard register is systematically
  -- weaker on that pass, so reported_p=FALSE on a re-check may mean "we chose
  -- not to look", not "the connector was down". The page says different things
  -- about those two, so they must be distinguishable.
  ADD COLUMN IF NOT EXISTS ocr_skipped BOOLEAN NOT NULL DEFAULT FALSE,
  -- Set on the PRIMARY run when the elapsed-time guard skipped the re-check
  -- pass. That fact currently exists only in the cron's HTTP response body and
  -- is discarded, so "this date has only one run" is indistinguishable from
  -- "the platform killed us". It turns an absence into an explanation.
  ADD COLUMN IF NOT EXISTS recheck_skipped_reason TEXT;

-- Named DROP/ADD rather than an inline CHECK on ADD COLUMN IF NOT EXISTS: on a
-- second apply the IF NOT EXISTS skips the whole clause, constraint included, so
-- an inline CHECK could silently never be created. Same pattern 0016 used for
-- email_logs_kind_check.
ALTER TABLE public.reconciliation_runs
  DROP CONSTRAINT IF EXISTS reconciliation_runs_run_role_check;
ALTER TABLE public.reconciliation_runs
  ADD CONSTRAINT reconciliation_runs_run_role_check
  CHECK (run_role IN ('primary', 'recheck', 'adhoc', 'unknown'));

COMMENT ON COLUMN public.reconciliation_runs.run_role IS
  'primary = the scheduled first pass for this date; recheck = the scheduled second pass (cron GET, no ?date=); adhoc = an admin re-run or an explicit ?date=; unknown = written before migration 0017 and NOT inferable (trigger is identical for primary and recheck). Orthogonal to `trigger`, which records who started the run.';
COMMENT ON COLUMN public.reconciliation_runs.ocr_skipped IS
  'Step 0 (guard-register OCR) was skipped for this run. TRUE on every re-check pass. Distinguishes "we did not look at the gate register" from "the guard connector failed"; both otherwise present as reported_p = FALSE.';
COMMENT ON COLUMN public.reconciliation_runs.recheck_skipped_reason IS
  'On a PRIMARY run: why no re-check pass followed it (e.g. "budget: 47231ms elapsed of 40000ms"). NULL means a re-check was attempted, or this is not a scheduled primary run.';


-- ---------------------------------------------------------------------------
-- B) run_city_snapshots -- the per-run, per-city record
--
-- Deliberately NOT a JSONB by_city column on reconciliation_runs, which was the
-- cheaper change (that row is already insert-per-run, and finalizeRun already
-- UPDATEs it, so the write would have been free) and is blocked on ONE thing:
-- 0001's runs_select policy is `auth.role() = 'authenticated'`, i.e. every user
-- reads every run row. A JSONB blob CANNOT be row-filtered by a policy, so
-- per-city counts -- and per-city BARCODES -- on that table would be readable by
-- every city manager. Every other city-bearing table here (source_rows,
-- variances, run_city_stats, movement_events) is
-- auth_is_admin() OR city = auth_city(). A separate table is the only way to
-- keep that true.

CREATE TABLE IF NOT EXISTS public.run_city_snapshots (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- CASCADE, deliberately NOT the SET NULL that 0015 chose. There run_id was
  -- "the last run that touched this row" on a table keyed by natural key; here
  -- run_id IS the identity. A null-run_id snapshot is an unorderable,
  -- unlabellable row for a run whose status and role no longer exist, and the
  -- page must never compare against a run it cannot name. In practice this
  -- CASCADE deletes nothing: prune_expired() only removes status='failed' runs,
  -- and a run that fails is marked failed by markRunFailed BEFORE the pipeline
  -- step that writes here is ever reached.
  run_id         UUID NOT NULL REFERENCES public.reconciliation_runs(id) ON DELETE CASCADE,

  business_date  DATE NOT NULL,
  city           TEXT NOT NULL
                 CHECK (city IN ('DELHI','MUMBAI','PUNE','HYDERABAD','BANGALORE')),

  -- DENORMALISED copy of reconciliation_runs.created_at. "The passes for date D
  -- in order" is this page's primary query, and this makes it a range scan on
  -- the index below instead of a join on every load.
  run_started_at TIMESTAMPTZ NOT NULL,

  -- Bumped when the meaning of a column changes, so a reader can refuse a row it
  -- does not understand rather than half-understanding it -- the same discipline
  -- parseTotalsSnapshot() enforces for 0016.
  schema_version SMALLINT NOT NULL DEFAULT 1,

  -- ── What this run CONCLUDED, for this city ────────────────────────────────
  --
  -- All of it is CityRunResult.summary, which already exists and is currently
  -- written only to run_city_stats, where the next pass overwrites it.
  movements      INT NOT NULL DEFAULT 0,   -- accuracy denominator, as THIS run saw it
  -- Rows the ENGINE EMITTED this run. Deliberately not called `open`: the
  -- digest's `open` means status != 'closed', a human-workflow fact read back
  -- from the DB. This is "what the reconciliation FOUND", independent of anyone's
  -- triage, which is exactly the first question this page asks.
  emitted_count  INT NOT NULL DEFAULT 0,
  real_count     INT NOT NULL DEFAULT 0,
  info_count     INT NOT NULL DEFAULT 0,
  high_count     INT NOT NULL DEFAULT 0,

  -- TIER counts (lib/ui/variance-labels.ts), counted PER UNIT at its worst tier,
  -- so tier1 + tier2 + tier3 = distinct units and each unit appears in exactly
  -- one of the three key arrays below. That is deliberately NOT equal to
  -- emitted_count, which counts ROWS: classifyViews can push a ladder hit AND a
  -- duplicate-scan hit for one unit.
  --
  -- Not derivable later from the names alone: labelFor() needs direction,
  -- job_type, bucket AND note, and the CLEARED_ON_RECHECK override is disabled
  -- entirely when bucket is absent. 0016's header worked through this and reached
  -- the same conclusion -- a recomputed tier is a plausible, WRONG number, which
  -- is worse than no number.
  tier1_count    INT NOT NULL DEFAULT 0,   -- "Stock at risk"
  tier2_count    INT NOT NULL DEFAULT 0,   -- "Records to fix"
  tier3_count    INT NOT NULL DEFAULT 0,   -- "For information"
  -- tier1 + tier2, STORED rather than derived, so this page and a future email
  -- can never define "flagged" differently. The CHECK below makes that a
  -- database guarantee rather than a convention -- which is more than 0016 could
  -- assert for the same field in prose.
  flagged_count  INT NOT NULL DEFAULT 0,

  -- Per-name breakdown, per city, per run. reconciliation_runs.by_variance is the
  -- same thing GLOBALLY. ~22 keys, ~1 KB. Kept because it survives the key prune
  -- below: after 120 days the page loses item-level detail but keeps the
  -- name-level shape of every run forever.
  by_variance    JSONB NOT NULL DEFAULT '{}',

  -- ── What this run did to EARLIER runs of the same date ────────────────────
  --
  -- resolveStaleOpenVariances returns these globally and the pipeline discards
  -- the split. Stored per city so the page has a SECOND, independent number to
  -- check its key-diff against: if "cleared" from the diff and these disagree,
  -- the page shows neither and says so.
  --
  -- Superseded rows were hard-DELETEd, so superseded_count is the only surviving
  -- trace that they existed at all.
  superseded_count    INT NOT NULL DEFAULT 0,
  resolved_late_count INT NOT NULL DEFAULT 0,

  -- ── COVERAGE: what this run could SEE ────────────────────────────────────
  --
  -- The reason this table exists rather than a prettier chart. Without these four
  -- booleans the page can show real=101 next to real=26 and the reader will
  -- conclude 75 items were fixed. They were not.
  --
  -- These are the POST-GUARD values -- the reportedByCity that
  -- guardTruncatedSheet returned, not the raw pull. A sheet that came back
  -- materially short has already been demoted to S=false by then, and this
  -- snapshot must inherit that demotion or it re-opens the exact hole
  -- lib/reconcile/sheet-guard.ts was written to close.
  reported_p     BOOLEAN NOT NULL DEFAULT FALSE,
  reported_s     BOOLEAN NOT NULL DEFAULT FALSE,
  reported_d     BOOLEAN NOT NULL DEFAULT FALSE,
  reported_o     BOOLEAN NOT NULL DEFAULT FALSE,

  -- WHY reported_s is false, when it is. "The Sheets connector was down" and
  -- "the pull came back at 34% of what we recorded earlier" are different facts,
  -- and guardTruncatedSheet collapses them both into S=false. The page says
  -- different things about them.
  sheet_truncated BOOLEAN NOT NULL DEFAULT FALSE,

  -- HOW MUCH thinner. A boolean says a source was missing; these say a run saw
  -- 40 DT rows where the earlier run saw 260. computeCountLayer already produced
  -- them (0012); run_city_stats holds them and overwrites them.
  --
  -- RAW ROW COUNTS, including duplicate scans -- never a movement total. 0012's
  -- header is the authority: a zero here cannot distinguish "the connector was
  -- down" from "nothing moved", which is what reported_* above is for.
  sheet_in  INT NOT NULL DEFAULT 0,
  sheet_out INT NOT NULL DEFAULT 0,
  odoo_in   INT NOT NULL DEFAULT 0,
  odoo_out  INT NOT NULL DEFAULT 0,
  dt_in     INT NOT NULL DEFAULT 0,
  dt_out    INT NOT NULL DEFAULT 0,
  phys_in   INT NOT NULL DEFAULT 0,
  phys_out  INT NOT NULL DEFAULT 0,

  -- ── ITEM LEVEL ───────────────────────────────────────────────────────────
  --
  -- The natural key of every unit this run flagged, split by the tier THIS RUN
  -- assigned it: CITY|DIRECTION|BARCODE|VARIANCE_NAME, produced by flaggedKeyOf()
  -- in lib/email/followup/snapshot.ts -- the SAME function 0016 uses, reused
  -- verbatim rather than re-spelled, so this page and the follow-up email can
  -- never disagree about what "the same unit" means.
  --
  -- Each unit appears in EXACTLY ONE array, at its worst tier. So a set
  -- difference over these is a difference in units, not in rows.
  --
  -- Split by tier rather than one array plus a recomputed tier, for the reason
  -- given above: the key carries name and direction but not bucket or note, and a
  -- tier recomputed without those puts a resolved item back on the chase list.
  --
  -- TEXT[] not JSONB: the row is already structured, arrays TOAST the same way,
  -- and `'DELHI|OUT|CF10231|...' = ANY(tier1_keys)` needs no casting.
  --
  -- NULL IS A REAL VALUE and means "no keys stored" -- a row written while this
  -- migration was half-applied, or a row whose keys have been pruned (see
  -- keys_pruned). '{}' means "this run flagged nothing at this tier for this
  -- city", which is a completely different statement. Consumers MUST branch on
  -- NULL and refuse the item-level diff, never treat it as empty.
  tier1_keys     TEXT[],
  tier2_keys     TEXT[],
  tier3_keys     TEXT[],

  -- The key budget was exhausted, so the arrays are a PREFIX. The page must then
  -- show counts only and suppress "which units cleared" -- 0016's keysTruncated,
  -- same rule: omit the line rather than print a number you cannot stand behind.
  keys_truncated BOOLEAN NOT NULL DEFAULT FALSE,
  -- prune_run_snapshot_keys() has NULLed the arrays. Distinguishes "we let this
  -- go at 120 days" from "we never had it".
  keys_pruned    BOOLEAN NOT NULL DEFAULT FALSE,

  -- TRUE for rows written by a script re-running the engine over retained
  -- source_rows rather than by the run itself. Same flag and same reason as
  -- movement_events.backfilled: a reconstruction reports what is true about that
  -- night NOW, not what the run concluded then, and without the flag the history
  -- would quietly overstate its own fidelity.
  backfilled     BOOLEAN NOT NULL DEFAULT FALSE,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One snapshot per city per run. A re-run creates a NEW run row and therefore a
  -- NEW snapshot row; that is the entire point, and the opposite of what
  -- variances and run_city_stats do. This constraint exists to catch a double
  -- write, not to permit one -- the writer INSERTs, it does not upsert.
  UNIQUE (run_id, city),

  -- flagged_count is stored, not derived. This makes it impossible to store a
  -- flagged_count that disagrees with its own tiers. Arithmetic on stored columns
  -- only -- it cannot fire unless the builder is wrong, and if the builder is
  -- wrong then losing one snapshot is the correct outcome.
  --
  -- NOT also asserting tier1+tier2+tier3 = emitted_count: they measure different
  -- things (units vs rows), by design, as documented above.
  CONSTRAINT run_city_snapshots_flagged_check
    CHECK (flagged_count = tier1_count + tier2_count),

  -- THE STORAGE CEILING, enforced here and not only in code.
  --
  -- 1200 keys per (run, city) across all three tiers. Measured: ~700 variance
  -- rows/date across five cities (~140/city), so 1200 is roughly 3.4x the worst
  -- plausible city-day and truncation should effectively never fire. At the
  -- ceiling a row is 1200 x 55 B = 66 KB, so a 7-run date costs 2.3 MB.
  --
  -- A CHECK rather than trust, because the failure it prevents -- unbounded
  -- growth of a barcode list on a Hobby-tier database -- is far worse than one
  -- missing snapshot, and a code-only cap is one refactor away from gone.
  CONSTRAINT run_city_snapshots_key_budget_check
    CHECK (
      COALESCE(cardinality(tier1_keys), 0)
    + COALESCE(cardinality(tier2_keys), 0)
    + COALESCE(cardinality(tier3_keys), 0) <= 1200
    )
);

-- THE index: "the passes for this date and city, in order" is the page's primary
-- query and every other read is a range over it.
CREATE INDEX IF NOT EXISTS idx_rcsnap_date_city
  ON public.run_city_snapshots (business_date, city, run_started_at DESC);

-- No idx_rcsnap_run: UNIQUE (run_id, city) is already a run_id-leading b-tree.
-- No partial index for the key-prune sweep either: 120 days x ~15 rows/date is
-- ~1,800 live rows and a seq scan on that is free. 0013's footer makes the same
-- argument -- an index that costs write time on the nightly path for no read is a
-- cost, not a safeguard.

-- RLS. NOT optional: tier*_keys contain barcodes, so without a policy a city
-- manager reads every city's flagged units for every run. Identical predicate to
-- variances / run_city_stats / movement_events (0004, 0005, 0015). SELECT only --
-- writes go through the service-role client in the pipeline, which bypasses RLS.
ALTER TABLE public.run_city_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS run_city_snapshots_select ON public.run_city_snapshots;
CREATE POLICY run_city_snapshots_select ON public.run_city_snapshots
  FOR SELECT USING (public.auth_is_admin() OR city = public.auth_city());

COMMENT ON TABLE public.run_city_snapshots IS
  'What ONE run concluded about ONE city, and how much of the day it could see. Written once per run per city and never updated. A city ABSENT from a run''s rows was NOT RECONCILED by that run (it was skipped, or had no data) -- render "not run", never zero. Contains barcodes in tier*_keys; city-scoped under RLS.';
COMMENT ON COLUMN public.run_city_snapshots.reported_s IS
  'Post-guard: guardTruncatedSheet has already demoted a materially short sheet pull to FALSE before this is written. Read with sheet_truncated to tell an outage from a truncation.';
COMMENT ON COLUMN public.run_city_snapshots.tier1_keys IS
  'CITY|DIRECTION|BARCODE|VARIANCE_NAME per flaggedKeyOf(). Each unit appears in exactly one tier array, at its worst tier. NULL = never stored or pruned (check keys_pruned); ''{}'' = genuinely none. Diff on the first three fields (unitKeyOf), never the full key: resolveStaleOpenVariances DELETEs a superseded row and its replacement carries a fresh name, so full-key matching reports a still-broken unit as cleared -- an error in the flattering direction.';
COMMENT ON COLUMN public.run_city_snapshots.emitted_count IS
  'Variance ROWS the engine emitted. Deliberately NOT equal to tier1+tier2+tier3, which count distinct UNITS: one unit can raise a ladder hit and a duplicate-scan hit.';


-- ---------------------------------------------------------------------------
-- C) Key retention -- 120 days, and only the keys.
--
-- The counts are ~1.2 KB/row and worth keeping forever (~7 MB/year). The keys are
-- ~90% of the bytes and stop being interesting once a date is closed out. So the
-- arrays are NULLed and the row SURVIVES, rather than the row being deleted: "we
-- had this and let it go" stays distinguishable from "we never had it", the same
-- distinction 0013 drew for its all-false sentinel.
--
-- A SEPARATE FUNCTION, deliberately NOT an edit to prune_expired(). 0001 defines
-- that function in full and 0015's footer already notes that any CREATE OR
-- REPLACE of it makes 0001's copy stale. Reproducing its body here to append one
-- statement means any transcription slip silently changes retention for
-- source_rows, variances and reconciliation_runs. One extra rpc call in the
-- pipeline is cheaper than that risk.

CREATE OR REPLACE FUNCTION public.prune_run_snapshot_keys()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  n integer;
BEGIN
  UPDATE public.run_city_snapshots
     SET tier1_keys  = NULL,
         tier2_keys  = NULL,
         tier3_keys  = NULL,
         keys_pruned = TRUE
   WHERE business_date < CURRENT_DATE - INTERVAL '120 days'
     AND keys_pruned = FALSE;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

COMMENT ON FUNCTION public.prune_run_snapshot_keys() IS
  'Retention for run_city_snapshots.tier*_keys only -- 120 days. Counts, coverage and by_variance are kept indefinitely. Separate from prune_expired() so 0001''s definition of that function stays authoritative.';


-- ---------------------------------------------------------------------------
-- D) One index on the movement ledger, for the long-range warehouse rollup.
--
-- "How many movements did each warehouse handle over an arbitrary date range"
-- needs NO new table: movement_events (0015) already holds one row per canonical
-- barcode per direction per business date, retained long-term, and it is the only
-- correct source -- it is upserted on the natural key, so a 7-run date counts
-- once, which is exactly what source_rows (plain-insert; 4,106 stored rows for a
-- date whose run pulled 896) would get wrong.
--
-- What it lacks is an index carrying `direction` and the is_movement filter.
-- idx_me_date_city is (business_date, city) only, so a 12-month rollup reads
-- every CLEAN row's heap tuple to test is_movement -- and CLEAN rows are the bulk
-- of the table (measured 2026-07-29: 9,516 of 10,719). Partial plus the third
-- column makes the rollup index-only.
CREATE INDEX IF NOT EXISTS idx_me_range_rollup
  ON public.movement_events (business_date, city, direction)
  WHERE is_movement;


-- ---------------------------------------------------------------------------
-- BACKFILL: none, and not for want of trying.
--
-- Per-run, per-city tier counts, coverage and key lists for every run before this
-- migration is applied are GONE, permanently, and there is no partial
-- reconstruction worth having:
--
--   * variances is upserted with run_id re-stamped -- the first run's verdict for
--     every date in the table is already overwritten, not versioned.
--   * run_city_stats is upserted on (business_date, city) -- the re-check pass has
--     already overwritten the primary pass's counts and coverage mask.
--   * reconciliation_runs.by_variance is name-keyed and GLOBAL; deriving tiers
--     from it means calling labelFor(name) with no direction, no job_type and no
--     bucket -- and direction alone moves GATE_ONLY, SHEET_ONLY and
--     GATE_OPS_NO_DT_ODOO between tier 1 and tier 2, while a null bucket disables
--     the CLEARED_ON_RECHECK override entirely.
--   * superseded rows were hard-DELETEd with no tombstone.
--   * run_role is unrecoverable even in principle -- see the argument at (A).
--
-- The one theoretical exception, declined: for the ~6 dates still inside the
-- source_rows 7-day window, source_rows.run_id IS NOT NULL, so the feed could be
-- partitioned by run and the engine re-run per run. It would still be a
-- reconstruction rather than a recording -- loadRecentFloorBarcodes reads TODAY's
-- source_rows for its +/-3 day window (since pruned and added to), the Odoo
-- +/-1 day window sees postings made since, and mergeOcrOrphans is not
-- deterministic across a changed input set. Six dates of approximately-right
-- history is not worth the code. If anyone does it anyway, `backfilled` exists
-- for exactly that, on the same argument as movement_events.backfilled.
--
-- So: dates before this migration show current state only, labelled "no per-run
-- history was recorded for this date" -- no delta, no cleared count. Same
-- discipline as 0016's "no fallback, deliberately". The feature starts working
-- the day this is applied, and every day of delay is a day lost for good.
