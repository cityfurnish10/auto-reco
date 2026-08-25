-- 0031_trip_completeness.sql
--
-- "You have scanned 12. Fifteen were planned. These three are missing."
--
-- HOW A TRIP KNOWS WHAT BELONGS TO IT. The guard never picks a task from a
-- list, and that is deliberate: the moment a guard tells the app what should be
-- on the truck, the gate stops being an independent record and becomes an echo
-- of Odoo. The whole value of this source is that it is the one place a human
-- physically saw the item.
--
-- So the trip's scope is DISCOVERED FROM THE SCANS. Scan an item, and the
-- picking it belongs to is now in play; if that picking has nine lines and only
-- three were scanned, six are missing. Nothing is ever ticked by hand, and a
-- picking nobody scanned from is not this trip's problem.
--
-- WARN, LET IT GO, RECORD THE GAP. Agreed with operations: a guard who cannot
-- close a trip is a guard who stops using the app. The truck leaves either way;
-- what changes is whether anyone can see afterwards that it left short.
--
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. What the check found, on the trip it checked.
-- ---------------------------------------------------------------------------
-- On gate_trips rather than a table of its own: there is exactly one result per
-- trip, it is read whenever the trip is read, and a join to fetch a single
-- integer is a cost paid on every dashboard query forever.
ALTER TABLE gate_trips
  ADD COLUMN IF NOT EXISTS expected_checked_at  TIMESTAMPTZ,
  -- Planned lines across every picking this trip touched.
  ADD COLUMN IF NOT EXISTS expected_total       INT,
  -- ...of which the guard actually scanned this many.
  ADD COLUMN IF NOT EXISTS expected_scanned     INT,
  -- ...leaving these. The barcodes themselves, because a count alone cannot be
  -- investigated the next morning and this is evidence, not a metric.
  ADD COLUMN IF NOT EXISTS expected_missing     JSONB,
  -- Scans that matched no planned line at all. The opposite failure, and the
  -- one that decides whether the warning can ever go live: an item loaded with
  -- no picking behind it would warn even against a perfect list.
  ADD COLUMN IF NOT EXISTS unplanned_count      INT,
  -- Did the guard SEE a warning, or was this recorded silently? For the first
  -- week it is silent, and the two cases must stay separable — otherwise the
  -- false-alarm rate is measured against guards who were never shown anything.
  ADD COLUMN IF NOT EXISTS expected_warned      BOOLEAN NOT NULL DEFAULT FALSE,
  -- How stale the list was when the check ran. A gap found against a
  -- forty-minute-old list is a weaker claim than one found against a fresh
  -- read, and next week's decision depends on being able to tell them apart.
  ADD COLUMN IF NOT EXISTS expected_list_age_s  INT;

COMMENT ON COLUMN gate_trips.expected_missing IS
  'Planned barcodes not scanned on this trip. Evidence for the morning after, not a metric.';
COMMENT ON COLUMN gate_trips.expected_warned IS
  'FALSE while the check runs silently — so the false-alarm rate is measured before any guard is taught to dismiss it.';

-- A count that disagrees with the list it came from is worse than no count.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gate_trips_expected_sane') THEN
    ALTER TABLE gate_trips
      ADD CONSTRAINT gate_trips_expected_sane
      CHECK (
        expected_checked_at IS NULL
        OR (expected_total >= 0 AND expected_scanned >= 0
            AND expected_scanned <= expected_total)
      ) NOT VALID;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. The pickings a planned line belongs to.
-- ---------------------------------------------------------------------------
-- The check groups by picking_ref, so it has to be readable and indexed. It was
-- already stored; nothing selected it.
CREATE INDEX IF NOT EXISTS idx_gei_picking
  ON gate_expected_items (city, business_date, picking_ref)
  WHERE picking_ref IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Where a planned movement is going.
-- ---------------------------------------------------------------------------
-- Name, order details and delivery address, asked for so a guard closing a trip
-- can see WHAT is missing rather than a bare serial. Nullable and unused until
-- the DT pull carries them — Odoo alone does not know the delivery address.
ALTER TABLE gate_expected_items
  ADD COLUMN IF NOT EXISTS delivery_address TEXT,
  ADD COLUMN IF NOT EXISTS order_details    TEXT,
  -- Which system planned this line. Once DT and Odoo both feed the list, a gap
  -- that only one of them knew about is a different conversation from one they
  -- agreed on, and that is unrecoverable if the origin is not kept.
  ADD COLUMN IF NOT EXISTS planned_by       TEXT
    CHECK (planned_by IS NULL OR planned_by IN ('ODOO', 'DT'));

COMMENT ON COLUMN gate_expected_items.planned_by IS
  'ODOO or DT. A gap only one source predicted is a different problem from one both did.';

-- ---------------------------------------------------------------------------
-- 4. Reading the week of silent data.
-- ---------------------------------------------------------------------------
-- The question the pilot has to answer before any guard sees a warning: how
-- often would it have cried wolf? Exposed as a view so the answer is one query
-- rather than a JSONB expression somebody has to get right under pressure.
CREATE OR REPLACE VIEW gate_completeness_daily AS
  SELECT
    business_date,
    city,
    count(*)                                        AS trips_checked,
    count(*) FILTER (
      WHERE jsonb_array_length(coalesce(expected_missing, '[]'::jsonb)) > 0
    )                                               AS trips_with_a_gap,
    sum(expected_total)                             AS planned_lines,
    sum(expected_scanned)                           AS scanned_lines,
    sum(jsonb_array_length(coalesce(expected_missing, '[]'::jsonb)))
                                                    AS missing_lines,
    sum(unplanned_count)                            AS unplanned_scans,
    round(avg(expected_list_age_s))                 AS avg_list_age_s
  FROM gate_trips
  WHERE expected_checked_at IS NOT NULL
  GROUP BY business_date, city;

COMMENT ON VIEW gate_completeness_daily IS
  'How often the completeness check would have warned, per city per day. Read this before setting EXPECTED_CHECK_LIVE.';
