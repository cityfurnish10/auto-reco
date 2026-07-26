-- Sortable severity/workflow ranks for the variance table.
--
-- WHY: priority and status are TEXT with CHECK constraints, so ordering by the
-- column sorts alphabetically — "High, Info, Medium" for priority, and for
-- status "closed" before "open" because 'c' < 'o'. Both are the opposite of
-- what a triage screen needs. Postgres cannot order by a CASE expression
-- through PostgREST's ?order= param, so the rank has to be a real column.
--
-- GENERATED ALWAYS ... STORED means the engine's upsert never writes these and
-- they can never drift from the text column they mirror.
--
-- Safe to re-run. The API degrades to plain column ordering (and says so) if
-- this migration has not been applied yet, so applying it is not urgent.

ALTER TABLE variances
  ADD COLUMN IF NOT EXISTS priority_rank SMALLINT
    GENERATED ALWAYS AS (
      CASE priority
        WHEN 'High'   THEN 0
        WHEN 'Medium' THEN 1
        ELSE 2                  -- 'Info'
      END
    ) STORED;

-- Workflow order: what still needs someone, ending at done.
--   open → needs a manager
--   in_progress → flagged/disputed, being worked
--   pending_approval → waiting on an admin
--   closed → done
ALTER TABLE variances
  ADD COLUMN IF NOT EXISTS status_rank SMALLINT
    GENERATED ALWAYS AS (
      CASE status
        WHEN 'open'             THEN 0
        WHEN 'in_progress'      THEN 1
        WHEN 'pending_approval' THEN 2
        ELSE 3                  -- 'closed'
      END
    ) STORED;

-- Sorting is always applied on top of the (business_date, city) scoping the
-- dashboard uses, so lead with those to keep the index usable.
CREATE INDEX IF NOT EXISTS idx_var_priority_rank
  ON variances (business_date, city, priority_rank);
CREATE INDEX IF NOT EXISTS idx_var_status_rank
  ON variances (business_date, city, status_rank);
-- "Oldest unresolved first" is the other common triage sort.
CREATE INDEX IF NOT EXISTS idx_var_first_seen
  ON variances (business_date, city, first_seen_at);

COMMENT ON COLUMN variances.priority_rank IS
  'Generated: 0=High 1=Medium 2=Info. Exists only so ?order=priority_rank sorts by severity rather than alphabetically.';
COMMENT ON COLUMN variances.status_rank IS
  'Generated: 0=open 1=in_progress 2=pending_approval 3=closed — workflow order, not alphabetical.';
