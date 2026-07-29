-- Canonical barcode on source_rows, so the evidence panel can find the rows it
-- is currently accusing of not existing.
--
-- WHY: source_rows.barcode is the RAW spelling the connector produced.
-- saveSourceRows (lib/db/persist.ts) writes r.barcode untouched, and that is
-- deliberate — views.ts builds SourcePresence.rawBarcodes from it, and
-- rawBarcodesDiffer() is the evidence for the "All Sources Agree — Barcode Text
-- Differs" rung. Normalising the column at write time would destroy the
-- drilldown's audit value and disarm a ladder rung.
--
-- variances.barcode, by contrast, is the CANONICAL form from canonicalize() in
-- lib/engine/barcode.ts. app/api/sources/route.ts filtered
--   .eq("barcode", <canonical>)
-- which is an exact match of a canonical string against a raw column. It
-- matched only when the source happened to spell the barcode canonically.
--
-- Measured on live data 2026-07-29:
--   * 54% of sampled source_rows differ from their canonical form,
--     concentrated in ODOO and DT;
--   * 117 of the 203 variance rows for 2026-07-26 had source evidence the
--     evidence panel could not see.
--
-- Two real cases:
--   variance FU10L223020032 -> panel found 0 rows and rendered "No record"
--     against all four sources. Three rows existed, spelled FU1OL223020032
--     and FUIOL223020032.
--   variance AP8157260160106 -> panel found 0. Two existed as AP8IS7260160106.
--
-- So the panel was not merely unhelpful: it made an affirmative false
-- accusation against a source that HAD the unit. It could not fall through to
-- the honest "these rows were pruned" branch either, because that branch
-- (nothingRetained in variance-detail-modal.tsx) additionally requires all four
-- coverage counts to be zero, and they were not.
--
-- WHY A GENERATED STORED COLUMN, and not an expression index, an RPC or a view:
-- PostgREST cannot call a SQL function inside a filter, so an expression index
-- is unreachable from the JS client. Migration 0011 hit the identical wall for
-- ORDER BY and answered it the same way (priority_rank/status_rank are real
-- columns for exactly this reason). A generated column keeps .eq(), .range(),
-- count:"exact" (which the coverage probes read from Content-Range), select("*")
-- and RLS all working unchanged, needs one identifier changed in the route, and
-- cannot drift because the writer never supplies it.
--
-- An RPC would also have to re-implement run_id/source/city filtering, paging
-- and — critically — RLS, since a SECURITY DEFINER function bypasses
-- source_rows_select entirely. A view would need security_invoker=true or it
-- silently leaks every city to a manager.
--
-- Safe to re-run. Additive only; nothing existing changes.

-- ---------------------------------------------------------------------------
-- The SQL twin of canonicalize() in lib/engine/barcode.ts.
--
-- The TS is:
--     const upper = raw.toUpperCase().replace(/\s+/g, "");
--     for (const ch of upper) out += FOLD[ch] ?? ch;
-- so the order is UPPERCASE -> STRIP WHITESPACE -> FOLD, and this reproduces it
-- in that order. Folding must come last because FOLD's keys are uppercase.
--
-- The whitespace class is spelled out rather than using \s. Postgres's \s is
-- [[:space:]], which under glibc does NOT match U+00A0 NO-BREAK SPACE — but
-- JavaScript's \s does. Sheet and DT rows originate in Google Sheets and Mongo,
-- where a pasted NBSP is routine. One left in place would fold to a DIFFERENT
-- canonical than the engine produced, which is the exact class of bug this
-- migration exists to close.
CREATE OR REPLACE FUNCTION public.canonicalize_barcode(raw TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT translate(
           translate(
             regexp_replace(upper(raw), '[[:space:]]+', '', 'g'),
             -- The whitespace JavaScript's \s matches but Postgres's
             -- [[:space:]] does not: NBSP and friends. Sheets and Mongo rows carry
             -- pasted NBSP routinely, and one left in place folds to a DIFFERENT
             -- canonical than the engine produced -- the exact class of bug this
             -- migration closes. translate() with a shorter 'to' DELETES them,
             -- which is what we want here.
             --
             -- Written as E'' escapes, never literal characters: they are invisible
             -- in an editor and one stray edit would silently change the set.
             -- This file is pure ASCII by design; a parity test proves the result
             -- matches canonicalize() on every retained row.
             E'\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF',
             ''
           ),
           -- FOLD in lib/engine/barcode.ts: I->1 O->0 S->5 Z->2 G->6.
           -- DO NOT WIDEN -- see the function comment below, and the shape test in
           -- tests/engine/barcode.test.ts which names this file when it fails.
           'IOSZG',
           '10526'
         );
$$;

COMMENT ON FUNCTION public.canonicalize_barcode(TEXT) IS
  'SQL twin of canonicalize() in lib/engine/barcode.ts: uppercase, strip whitespace, fold I->1 O->0 S->5 Z->2 G->6. NOTE: CREATE OR REPLACE on this function does NOT recompute source_rows.barcode_canonical. To change the fold you must DROP the column, replace the function, then re-ADD the column — otherwise old rows keep the old canonical while new rows use the new one, and the join to variances.barcode breaks silently for historical dates. Parity with the TS is proved by tests/db/canonical-parity.test.ts against live rows.';

-- ---------------------------------------------------------------------------
-- STORED, not the PG17 VIRTUAL form: virtual generated columns cannot be
-- indexed, and this may run on PG 15/16.
--
-- Adding it rewrites the table under an ACCESS EXCLUSIVE lock. At the ~72k rows
-- source_rows retains (it is pruned to 7 days) that is a couple of seconds, but
-- it will block a concurrent saveSourceRows — do not apply during the 16:00
-- reconcile window.
ALTER TABLE public.source_rows
  ADD COLUMN IF NOT EXISTS barcode_canonical TEXT
    GENERATED ALWAYS AS (public.canonicalize_barcode(barcode)) STORED;

COMMENT ON COLUMN public.source_rows.barcode_canonical IS
  'canonicalize_barcode(barcode). Exists so PostgREST can filter on the canonical form, which is what variances.barcode holds. The barcode column itself stays RAW on purpose: the drilldown shows what each source actually wrote, and views.ts rawBarcodesDiffer() needs the distinct spellings.';

-- ---------------------------------------------------------------------------
-- Indexes.

-- Mirrors idx_sr_barcode's shape (0001). The evidence drilldown filters
-- run_id + city + barcode; barcode-leading also serves "every day this unit
-- appears", which is what the barcode journey feature asks.
CREATE INDEX IF NOT EXISTS idx_sr_barcode_canonical
  ON public.source_rows (barcode_canonical, business_date, city);

-- variances has NO barcode-leading index today. Its dedup key is
-- (business_date, city, direction, barcode, variance_name) with barcode FOURTH,
-- so it cannot serve WHERE barcode = ? without a date, and every other index on
-- the table (0001, 0011) leads with bucket/status/variance_source/priority/
-- run_id. "The history of this unit" is therefore a sequential scan of the
-- whole table today.
CREATE INDEX IF NOT EXISTS idx_var_barcode
  ON public.variances (barcode, business_date DESC);

-- Plain CREATE INDEX rather than CONCURRENTLY: the Supabase SQL editor wraps
-- statements in a transaction, and CONCURRENTLY cannot run inside one. At this
-- size the build is sub-second.

-- ---------------------------------------------------------------------------
-- ROLLBACK, or changing the fold:
--   ALTER TABLE public.source_rows DROP COLUMN IF EXISTS barcode_canonical;
--   DROP INDEX IF EXISTS idx_sr_barcode_canonical;
--   -- then edit canonicalize_barcode() above and re-run this file.
-- Dropping the column is what forces recomputation. Replacing the function
-- alone leaves every stored value stale AND makes new rows disagree with old.
