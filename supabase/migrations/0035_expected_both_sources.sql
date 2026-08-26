-- 0035_expected_both_sources.sql
--
-- Let one expected line say that BOTH systems predicted it.
--
-- 0031 added planned_by with a CHECK allowing 'ODOO' or 'DT'. That was written
-- before DT was wired and it is one value short: the two systems describe the
-- same physical movement from different angles — Odoo knows the picking and
-- the serial, DT knows the customer and the address — and the common case is
-- that both name the same barcode on the same day.
--
-- Letting one silently overwrite the other would throw away exactly the
-- distinction worth keeping. An item only DT predicted, with no Odoo picking
-- behind it, is a gap in Odoo. An item only Odoo predicted, with no delivery
-- task, is a gap in DT. An item both agreed on is neither. Merged into an
-- anonymous list, all three look identical.
--
-- Safe to re-run.

ALTER TABLE gate_expected_items DROP CONSTRAINT IF EXISTS gate_expected_items_planned_by_check;

ALTER TABLE gate_expected_items
  ADD CONSTRAINT gate_expected_items_planned_by_check
  CHECK (planned_by IS NULL OR planned_by IN ('ODOO', 'DT', 'BOTH'));

COMMENT ON COLUMN gate_expected_items.planned_by IS
  'ODOO, DT, or BOTH. A gap only one system predicted is a different problem from one they agreed on.';

-- Which system knew about what, per day. The question this answers is not
-- "how complete is the gate" but "how well do the two planning systems agree",
-- and a day where DT-only is large means Odoo pickings are being created late.
CREATE OR REPLACE VIEW gate_expected_agreement AS
  SELECT
    business_date,
    city,
    count(*)                                          AS lines,
    count(*) FILTER (WHERE planned_by = 'BOTH')       AS both_agreed,
    count(*) FILTER (WHERE planned_by = 'ODOO')       AS odoo_only,
    count(*) FILTER (WHERE planned_by = 'DT')         AS dt_only,
    count(*) FILTER (WHERE delivery_address IS NOT NULL) AS with_address
  FROM gate_expected_items
  GROUP BY business_date, city;

COMMENT ON VIEW gate_expected_agreement IS
  'Per day and city: what Odoo and DT each knew about. A large dt_only means Odoo pickings are late.';
