-- 0037_gate_scan_enrichment.sql
--
-- Give a gate scan the details that belong to the UNIT, without letting the
-- gate start agreeing with the plan.
--
-- THE PROBLEM. A QR code carries a serial and nothing else. The paper register
-- it replaces had columns for product, order and customer, written by hand — so
-- on the one class of item where the gate is the only witness, the app was a
-- step backwards: a manager chasing it saw a bare serial.
--
-- The existing enrichment path filled those from gate_expected_items — the
-- day's PLANNED movements. Two things are wrong with that. It barely fires
-- (the expected list averages ~24 rows a day against ~1,451 movements, so all
-- 39 live scans have every one of these fields null), and more importantly it
-- is the wrong source in principle: matching a gate scan against what Odoo
-- planned for today makes the fourth witness agree with the other three by
-- construction. That is the failure lib/gate/config.ts already refuses in the
-- UI, arriving through the database instead.
--
-- WHAT THIS DOES INSTEAD. Looks the serial up in Odoo's LOT MASTER — what the
-- unit IS, not where it is meant to go. Measured 2026-09-09 against real
-- serials: product resolves cleanly every time; last-known customer and order
-- resolve about a third of the time and are frequently an internal partner
-- ("Cityfurnish India Private Limited (gur)") rather than an end customer. So
-- product is the reliable field and the rest is a chase hint, stored as such.
--
-- WHY NEW COLUMNS AND NOT THE EXISTING ONES. gate_scans.product, .so_number,
-- .ticket_id and .customer are what the RECONCILIATION reads as the gate's own
-- testimony (lib/connectors/guard.ts). Writing Odoo-derived values into them
-- would hand the engine a gate row that agrees with Odoo about an order number
-- Odoo supplied — manufactured corroboration, and it would feed the guard-orphan
-- matcher in lib/engine/fuzzy.ts, which scores exactly those fields.
--
-- So derived context lives in its own columns, and the separation is the
-- guarantee: a human sees the enrichment, the engine never does.
--
-- Safe to re-run.

ALTER TABLE gate_scans
  ADD COLUMN IF NOT EXISTS unit_product    TEXT,
  ADD COLUMN IF NOT EXISTS unit_sku        TEXT,
  ADD COLUMN IF NOT EXISTS last_customer   TEXT,
  ADD COLUMN IF NOT EXISTS last_so         TEXT,
  ADD COLUMN IF NOT EXISTS last_moved_at   DATE,
  ADD COLUMN IF NOT EXISTS last_direction  TEXT,
  -- Null = never attempted. Set even when Odoo knows nothing about the serial,
  -- so the backfill does not retry an unknown unit forever.
  ADD COLUMN IF NOT EXISTS enriched_at     TIMESTAMPTZ;

COMMENT ON COLUMN gate_scans.unit_product IS
  'What this serial IS, from Odoo''s lot master. Identity, not a plan — safe to '
  'show a manager. Deliberately NOT gate_scans.product, which is the gate''s own '
  'testimony and is read by the reconciliation.';
COMMENT ON COLUMN gate_scans.last_customer IS
  'Customer on this unit''s most recent COMPLETED movement. History, never '
  'today''s plan, and often an internal partner — a chase hint, not evidence.';
COMMENT ON COLUMN gate_scans.enriched_at IS
  'When enrichment last ran for this row. Set even on a miss, so an unknown '
  'serial is not retried forever.';

-- Backfill target: anything scanned but never enriched. Partial index, because
-- the job only ever asks this one question and the table is append-heavy.
CREATE INDEX IF NOT EXISTS gate_scans_unenriched_idx
  ON gate_scans (business_date)
  WHERE enriched_at IS NULL;
