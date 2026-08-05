-- The barcode a human can actually search for.
--
-- THE BUG. canonicalize() in lib/engine/barcode.ts folds I->1, O->0, S->5,
-- Z->2, G->6 so that a photographed handwritten guard register matches the
-- typed systems. That fold is the right grouping key and the wrong LABEL: it is
-- applied to every source, and run.ts then writes it as the variance's barcode,
-- so the dashboard and the email print a string that may exist in no system at
-- all.
--
-- Measured 2026-08-05 over 128,411 retained source rows and 4,190 units seen by
-- a typed source: 2,392 of them -- 57.1% -- display a canonical that matches
-- NONE of the raw spellings Odoo, DT or the ops sheet recorded. Two reported
-- from the floor the same day:
--
--   Odoo, DT and the sheet all wrote FUMYGB23070029;  we showed FUMY6B23070029
--   Odoo's serial was    AP8IS725090229;              we showed AP815725090229
--
-- The second was raised as "Odoo Entry Created Today". It was true -- Odoo does
-- hold that move -- but searching Odoo for the string we printed returns
-- nothing, so a correct finding read as an invented one. A label nobody can
-- look up costs more than the finding is worth.
--
-- WHY A NEW COLUMN AND NOT A FIX TO THE OLD ONE. variances.barcode is part of
-- UNIQUE (business_date, city, direction, barcode, variance_name), and 0014
-- records what happens if the stored canonical moves: historical rows keep the
-- old value while new rows use the new one, the join to
-- source_rows.barcode_canonical breaks silently for past dates, and two old
-- canonicals collapsing into one violates that unique key. So the canonical
-- stays exactly where it is, doing exactly what it does, and the raw spelling
-- rides alongside it.
--
-- The fold itself is UNCHANGED, and must stay unchanged. It was also measured:
-- across those same 4,190 units it has never merged two different typed
-- spellings -- not once -- so it is not causing a single wrong match. It earns
-- its keep on the guard register and costs nothing elsewhere.
--
-- NULLABLE ON PURPOSE. Every row written before this migration has no raw
-- spelling stored anywhere once source_rows prunes at 7 days, and inventing one
-- would be worse than admitting we do not have it. Readers fall back to
-- `barcode` when this is NULL, so an unapplied migration and an old row behave
-- identically -- the display is simply what it is today.
--
-- Safe to re-run.

ALTER TABLE public.variances
  ADD COLUMN IF NOT EXISTS barcode_display TEXT;

COMMENT ON COLUMN public.variances.barcode_display IS
  'The raw spelling a typed source recorded, trust order ODOO > DT > SHEET > PHYSICAL. For humans and for searching the source systems. NULL on rows written before migration 0020 -- readers fall back to `barcode`. NEVER join on this: `barcode` is the canonical and the key.';

ALTER TABLE public.movement_events
  ADD COLUMN IF NOT EXISTS barcode_display TEXT;

COMMENT ON COLUMN public.movement_events.barcode_display IS
  'As variances.barcode_display. The ledger keys on the canonical `barcode`; this is the label.';

-- ---------------------------------------------------------------------------
-- BACKFILL, best effort, for the days source_rows still holds.
--
-- Picks the raw spelling from the most trustworthy source that saw the unit.
-- Rows outside the 7-day source_rows window keep NULL and fall back to the
-- canonical, which is what they display today anyway.
--
-- Re-runnable: only fills rows that are still NULL.
-- ---------------------------------------------------------------------------
WITH ranked AS (
  SELECT
    sr.barcode_canonical,
    sr.city,
    sr.direction,
    sr.business_date,
    upper(regexp_replace(sr.barcode, '\s', '', 'g')) AS raw,
    row_number() OVER (
      PARTITION BY sr.barcode_canonical, sr.city, sr.direction, sr.business_date
      ORDER BY CASE sr.source
                 WHEN 'ODOO'     THEN 1
                 WHEN 'DT'       THEN 2
                 WHEN 'SHEET'    THEN 3
                 WHEN 'PHYSICAL' THEN 4
                 ELSE 5
               END
    ) AS rn
  FROM public.source_rows sr
  WHERE sr.barcode_canonical IS NOT NULL
)
UPDATE public.variances v
SET barcode_display = r.raw
FROM ranked r
WHERE v.barcode_display IS NULL
  AND v.barcode       = r.barcode_canonical
  AND v.city          = r.city
  AND v.direction     = r.direction
  AND v.business_date = r.business_date
  AND r.rn = 1;

WITH ranked AS (
  SELECT
    sr.barcode_canonical,
    sr.city,
    sr.direction,
    sr.business_date,
    upper(regexp_replace(sr.barcode, '\s', '', 'g')) AS raw,
    row_number() OVER (
      PARTITION BY sr.barcode_canonical, sr.city, sr.direction, sr.business_date
      ORDER BY CASE sr.source
                 WHEN 'ODOO'     THEN 1
                 WHEN 'DT'       THEN 2
                 WHEN 'SHEET'    THEN 3
                 WHEN 'PHYSICAL' THEN 4
                 ELSE 5
               END
    ) AS rn
  FROM public.source_rows sr
  WHERE sr.barcode_canonical IS NOT NULL
)
UPDATE public.movement_events m
SET barcode_display = r.raw
FROM ranked r
WHERE m.barcode_display IS NULL
  AND m.barcode       = r.barcode_canonical
  AND m.city          = r.city
  AND m.direction     = r.direction
  AND m.business_date = r.business_date
  AND r.rn = 1;

-- ---------------------------------------------------------------------------
-- ROLLBACK
--   ALTER TABLE public.variances       DROP COLUMN IF EXISTS barcode_display;
--   ALTER TABLE public.movement_events DROP COLUMN IF EXISTS barcode_display;
-- Dropping it is safe at any time: every reader falls back to `barcode`.
-- ---------------------------------------------------------------------------
