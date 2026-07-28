-- Per-source presence flags on every variance row.
--
-- WHY: the engine already knows which of the four sources confirmed a unit —
-- it holds it as BarcodeView.P/S/D/O (SourcePresence) — and then threw it away:
-- baseRow() in lib/engine/run.ts copied only the identifying fields. So a row
-- could not answer "Gate yes / Register no / Dispatch yes / ERP no", and that
-- answer cannot be reconstructed later:
--
--   * source_rows is pruned after 7 days (prune_expired), so any date older
--     than a week has no evidence left at all;
--   * source_rows.barcode is the RAW spelling while variances.barcode is the
--     CANONICAL one, so even inside the 7-day window the join is lossy;
--   * the OCR-orphan merge (mergeOcrOrphans -> mergeGuardPresence) folds one
--     canonical's guard presence into a DIFFERENT canonical, and the
--     digits-only fragment drop deletes views outright. No join over stored raw
--     rows reproduces either. "Re-derive it later" really means "re-run the
--     engine", which is not something a UI badge can do.
--
-- Same argument migration 0012 made for the movement counts: every display path
-- reads the DATABASE, so the answer has to be persisted, not recomputed.
--
-- ALL FOUR present_* FALSE IS THE "NOT RECORDED" SENTINEL. Every row the engine
-- emits has at least one source present (a view only exists because some source
-- produced a row for it), so four falses can only mean the row was written
-- before this migration was applied. Render that as "not recorded for this
-- date" — never as four crosses.
--
-- Safe to re-run. Additive only; nothing existing changes.

ALTER TABLE public.variances
  -- Which sources CONFIRMED this unit, this direction, this date. Read at the
  -- moment the row is emitted, i.e. AFTER the OCR-orphan merge.
  ADD COLUMN IF NOT EXISTS present_p  BOOLEAN NOT NULL DEFAULT FALSE,  -- guard register
  ADD COLUMN IF NOT EXISTS present_s  BOOLEAN NOT NULL DEFAULT FALSE,  -- ops sheet
  ADD COLUMN IF NOT EXISTS present_d  BOOLEAN NOT NULL DEFAULT FALSE,  -- delivery app
  ADD COLUMN IF NOT EXISTS present_o  BOOLEAN NOT NULL DEFAULT FALSE,  -- Odoo
  -- Which sources REPORTED for this city+run at all. A source that was down
  -- must not be drawn as a cross: that blames it for an absence it never had
  -- the chance to fill — the same distinction 0012 drew on run_city_stats.
  -- Kept per-ROW here rather than joined from run_city_stats because that table
  -- is upserted on (business_date, city), so a later partial re-run would
  -- silently rewrite the coverage mask under rows that survived from a fuller
  -- earlier run.
  ADD COLUMN IF NOT EXISTS reported_p BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reported_s BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reported_d BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reported_o BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.variances.present_p IS
  'Guard register had a row for this canonical barcode + direction on this date, AFTER the OCR-orphan merge. All four present_* FALSE = row pre-dates migration 0013; render "not recorded", not four crosses.';
COMMENT ON COLUMN public.variances.present_s IS 'Ops sheet confirmed this unit.';
COMMENT ON COLUMN public.variances.present_d IS 'Delivery Tracker confirmed this unit.';
COMMENT ON COLUMN public.variances.present_o IS 'Odoo confirmed this unit, inside the +/-1 day posting window.';
COMMENT ON COLUMN public.variances.reported_p IS
  'The guard-register connector reported for this city+run. reported_p FALSE with present_p FALSE means "source down", NOT "the gate did not log it".';

-- On a CROSS (direction-conflict) row the flags are the OR of the IN leg and
-- the OUT leg. The row asserts that ONE unit both arrived and left today; the
-- evidence for that claim is the union of the two legs. Reading only the IN leg
-- would print "no dispatch record" for a unit whose OUT leg is the very reason
-- the row exists.
COMMENT ON COLUMN public.variances.direction IS
  'IN | OUT | CROSS. On CROSS rows the present_*/reported_* flags are the OR of both legs.';

-- No CHECK asserting "at least one present_* is true": that holds for every row
-- the engine writes but for none of the rows that already exist, so a CHECK
-- would make this migration un-appliable.
--
-- Existing rows keep FALSE and are NOT backfillable (see the header). The flags
-- fill forward from the first reconcile run after this migration is applied.
--
-- No index: these are display-only, read with the row and never filtered or
-- sorted on. An index would cost write time on the nightly upsert for no read.
-- Add one only if a "show me every unit the gate missed" filter ships, and then
-- as a partial index on (business_date, city) WHERE NOT present_p.
