-- 0025_guard_uniqueness.sql
--
-- Stop the same guard being added twice.
--
-- WHY THIS IS A MIGRATION AND NOT A FORM CHECK. Two identical guards were
-- created within a minute of each other because the LIST query was failing and
-- the screen showed "No guards yet" -- so the operator, reasonably, added them
-- again. A form check would not have helped: the form was working. Only the
-- database can refuse a duplicate no matter which screen, script or retry
-- produced it.
--
-- WHAT COUNTS AS A DUPLICATE, and what deliberately does not:
--
--   employee code   an identifier. Two guards cannot share one, and a repeat is
--                   always a mistake. Scoped per city because the codes are
--                   issued per warehouse.
--   phone           likewise, an identifier, and unique across the company.
--   NAME            NOT enforced here. Two people genuinely can be called the
--                   same thing, and blocking that outright would eventually
--                   stop a real hire from being added with no way round it.
--                   Handled in the API as a confirmation instead -- refused
--                   once, allowed if the operator says they mean it.
--
-- Both indexes ignore NULLs, so the fields stay optional.
--
-- Safe to re-run.

CREATE UNIQUE INDEX IF NOT EXISTS uq_guard_employee_code
  ON guard_profiles (city, employee_code)
  WHERE employee_code IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_guard_phone
  ON guard_profiles (phone)
  WHERE phone IS NOT NULL;

COMMENT ON INDEX uq_guard_employee_code IS
  'An employee code identifies one guard at one warehouse; a repeat is always a mistake.';
COMMENT ON INDEX uq_guard_phone IS
  'A phone number identifies one person. Names are deliberately not constrained — see 0025.';
