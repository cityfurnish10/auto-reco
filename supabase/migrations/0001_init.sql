-- ============================================================================
-- Cityfurnish Auto-Reco — Initial Schema
-- Migration: 0001_init.sql
-- Run with: supabase db push  (or paste into Supabase SQL Editor)
-- ============================================================================

-- Enable UUID generation (Supabase usually has this, but be safe)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ────────────────────────────────────────────────────────────────────────────
-- 1. app_users — platform accounts (synced from Supabase Auth)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_id     UUID UNIQUE,                          -- FK to auth.users (nullable for seed rows)
  email       TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'viewer'
              CHECK (role IN ('admin', 'manager', 'viewer')),
  city        TEXT                                   -- assigned city (managers only)
              CHECK (city IS NULL OR city IN ('DELHI','MUMBAI','PUNE','HYDRABAD','BANGALORE')),
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'inactive')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  app_users IS 'Platform users — admin (all cities), manager (one city), viewer (read-only).';
COMMENT ON COLUMN app_users.city IS 'Engine city code; NULL for admins (see all cities).';


-- ────────────────────────────────────────────────────────────────────────────
-- 2. reconciliation_runs — one row per pipeline execution
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_date   DATE NOT NULL,
  run_date        TEXT,                              -- engine-derived run date (may differ from business_date)
  trigger         TEXT NOT NULL DEFAULT 'manual'
                  CHECK (trigger IN ('cron', 'manual')),
  triggered_by    TEXT,                              -- user email or 'system'
  status          TEXT NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'success', 'partial', 'failed')),

  -- Aggregate counts (filled on finalizeRun)
  total           INT DEFAULT 0,
  real_count       INT DEFAULT 0,
  info_count       INT DEFAULT 0,
  high_priority   INT DEFAULT 0,
  by_variance     JSONB DEFAULT '{}',
  warnings        JSONB DEFAULT '[]',

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

-- Non-unique: the pipeline is expected to be re-run for the same business_date
-- (manual re-run after fixing a connector, retrying a failed run, etc). Variance
-- de-duplication happens at the variances table's own unique key, not here.
-- Callers wanting "the" run for a date should pick the latest by created_at.
CREATE INDEX IF NOT EXISTS idx_runs_date
  ON reconciliation_runs (business_date, created_at DESC);

COMMENT ON TABLE reconciliation_runs IS 'One row per reconciliation pipeline execution (cron or manual trigger).';


-- ────────────────────────────────────────────────────────────────────────────
-- 3. source_rows — raw connector output (pruned after 7 days)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS source_rows (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  business_date   DATE NOT NULL,
  source          TEXT NOT NULL
                  CHECK (source IN ('PHYSICAL', 'SHEET', 'DT', 'ODOO')),
  city            TEXT NOT NULL
                  CHECK (city IN ('DELHI','MUMBAI','PUNE','HYDRABAD','BANGALORE')),
  direction       TEXT NOT NULL
                  CHECK (direction IN ('IN', 'OUT')),
  barcode         TEXT NOT NULL,

  -- Optional fields (availability depends on source)
  status          TEXT,
  so_number       TEXT,
  ticket_id       TEXT,
  customer        TEXT,
  product         TEXT,
  job_type        TEXT,
  date            TEXT,
  created_on      TEXT,
  movement_date   TEXT,

  -- Full source payload for drilldown / audit
  raw             JSONB,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sr_run     ON source_rows (run_id);
CREATE INDEX IF NOT EXISTS idx_sr_barcode ON source_rows (barcode, business_date, city);
CREATE INDEX IF NOT EXISTS idx_sr_source  ON source_rows (source, business_date);

COMMENT ON TABLE  source_rows IS 'Raw rows pulled from all 4 connectors — kept for 7 days (prune_expired).';
COMMENT ON COLUMN source_rows.raw IS 'Full source-specific payload; extra columns not in the unified schema live here.';


-- ────────────────────────────────────────────────────────────────────────────
-- 4. variances — engine output + human resolution
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS variances (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            UUID NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  business_date     DATE NOT NULL,
  city              TEXT NOT NULL
                    CHECK (city IN ('DELHI','MUMBAI','PUNE','HYDRABAD','BANGALORE')),
  direction         TEXT NOT NULL
                    CHECK (direction IN ('IN', 'OUT', 'CROSS')),
  barcode           TEXT NOT NULL,
  variance_name     TEXT NOT NULL,

  -- Engine-derived columns (refreshed on every re-run)
  priority          TEXT NOT NULL
                    CHECK (priority IN ('High', 'Medium', 'Info')),
  original_priority TEXT
                    CHECK (original_priority IS NULL OR original_priority IN ('High', 'Medium', 'Info')),
  bucket            TEXT NOT NULL
                    CHECK (bucket IN ('REAL', 'INFO')),
  dampened          BOOLEAN NOT NULL DEFAULT false,
  responsible       TEXT NOT NULL,
  variance_source   TEXT
                    CHECK (variance_source IS NULL OR variance_source IN ('Odoo', 'DT', 'Sheet', 'Physical', 'Cross')),
  note              TEXT,

  -- Identifying detail from the source row
  ticket_id         TEXT,
  so_number         TEXT,
  customer          TEXT,
  product           TEXT,
  job_type          TEXT,
  date              TEXT NOT NULL,

  -- Timestamps
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Human resolution — NEVER overwritten by engine re-runs
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'in_progress', 'closed')),
  closed_by         UUID REFERENCES app_users(id),
  closed_at         TIMESTAMPTZ,
  closure_reason    TEXT,
  closure_note      TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Dedup key: same barcode + date + city + direction + variance type = same variance
  UNIQUE (business_date, city, direction, barcode, variance_name)
);

CREATE INDEX IF NOT EXISTS idx_var_run    ON variances (run_id);
CREATE INDEX IF NOT EXISTS idx_var_bucket ON variances (bucket, business_date, city);
CREATE INDEX IF NOT EXISTS idx_var_status ON variances (status, business_date, city);
CREATE INDEX IF NOT EXISTS idx_var_source ON variances (variance_source, business_date);
CREATE INDEX IF NOT EXISTS idx_var_prio   ON variances (priority, business_date);

COMMENT ON TABLE  variances IS 'Engine-detected variances. Dedup key prevents duplicates; human closures survive re-runs.';
COMMENT ON COLUMN variances.variance_source IS 'Odoo|DT|Sheet|Physical|Cross — populated by varianceSource() in the engine.';
COMMENT ON COLUMN variances.first_seen_at IS 'When this variance was first detected — never overwritten.';
COMMENT ON COLUMN variances.status IS 'Human-set: open → in_progress → closed. Engine NEVER touches this.';


-- ────────────────────────────────────────────────────────────────────────────
-- 5. ingestion_logs — per-connector health per run
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ingestion_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        UUID NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  source        TEXT NOT NULL
                CHECK (source IN ('PHYSICAL', 'SHEET', 'DT', 'ODOO')),
  status        TEXT NOT NULL
                CHECK (status IN ('OK', 'FAILED')),
  rows_pulled   INT NOT NULL DEFAULT 0,
  message       TEXT,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  duration_ms   INT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_il_run ON ingestion_logs (run_id);

COMMENT ON TABLE ingestion_logs IS 'One row per connector per run — used by System Health page.';


-- ────────────────────────────────────────────────────────────────────────────
-- 6. guard_uploads — OCR file upload tracking
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS guard_uploads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID REFERENCES reconciliation_runs(id),
  uploaded_by     UUID REFERENCES app_users(id),
  file_name       TEXT NOT NULL,
  file_path       TEXT NOT NULL,                     -- Supabase Storage path
  city            TEXT NOT NULL
                  CHECK (city IN ('DELHI','MUMBAI','PUNE','HYDRABAD','BANGALORE')),
  business_date   DATE NOT NULL,
  direction       TEXT NOT NULL
                  CHECK (direction IN ('IN', 'OUT')),
  rows_parsed     INT NOT NULL DEFAULT 0,
  rows_valid      INT NOT NULL DEFAULT 0,
  ocr_confidence  REAL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processed', 'failed')),
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gu_city_date ON guard_uploads (city, business_date);

COMMENT ON TABLE guard_uploads IS 'Guard register Excel/CSV uploads — tracks parse status and row counts.';


-- ────────────────────────────────────────────────────────────────────────────
-- 7. prune_expired() — retention backstop (called at end of each run)
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION prune_expired()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- Source rows older than 7 days (raw feed is only needed for short-term drilldown)
  DELETE FROM source_rows
  WHERE business_date < CURRENT_DATE - INTERVAL '7 days';

  -- Closed variances older than 90 days (resolved issues don't need to stay forever)
  DELETE FROM variances
  WHERE status = 'closed'
    AND closed_at < now() - INTERVAL '90 days';

  -- Failed runs older than 30 days
  DELETE FROM reconciliation_runs
  WHERE status = 'failed'
    AND created_at < now() - INTERVAL '30 days';
END;
$$;

COMMENT ON FUNCTION prune_expired() IS 'Retention backstop — source_rows 7d, closed variances 90d, failed runs 30d.';


-- ────────────────────────────────────────────────────────────────────────────
-- 8. Row-Level Security (RLS)
-- ────────────────────────────────────────────────────────────────────────────

-- Enable RLS on all tables
ALTER TABLE app_users             ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_runs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_rows           ENABLE ROW LEVEL SECURITY;
ALTER TABLE variances             ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_logs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE guard_uploads         ENABLE ROW LEVEL SECURITY;

-- Admins see everything; managers see their city only.
-- The service role (used by the cron pipeline) bypasses RLS entirely.

-- app_users: admins read all, others read themselves
CREATE POLICY app_users_select ON app_users
  FOR SELECT USING (
    auth.uid() = auth_id
    OR EXISTS (
      SELECT 1 FROM app_users u
      WHERE u.auth_id = auth.uid() AND u.role = 'admin'
    )
  );

-- reconciliation_runs: all authenticated users can read runs
CREATE POLICY runs_select ON reconciliation_runs
  FOR SELECT USING (auth.role() = 'authenticated');

-- source_rows: admins see all; managers see their city
CREATE POLICY source_rows_select ON source_rows
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM app_users u
      WHERE u.auth_id = auth.uid()
        AND (u.role = 'admin' OR u.city = source_rows.city)
    )
  );

-- variances: admins see all; managers see their city
CREATE POLICY variances_select ON variances
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM app_users u
      WHERE u.auth_id = auth.uid()
        AND (u.role = 'admin' OR u.city = variances.city)
    )
  );

-- variances: managers can update status (close/dispute) on their city's variances
CREATE POLICY variances_update ON variances
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM app_users u
      WHERE u.auth_id = auth.uid()
        AND (u.role = 'admin' OR u.city = variances.city)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM app_users u
      WHERE u.auth_id = auth.uid()
        AND (u.role = 'admin' OR u.city = variances.city)
    )
  );

-- ingestion_logs: all authenticated users can read
CREATE POLICY ingestion_logs_select ON ingestion_logs
  FOR SELECT USING (auth.role() = 'authenticated');

-- guard_uploads: admins see all; managers see their city
CREATE POLICY guard_uploads_select ON guard_uploads
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM app_users u
      WHERE u.auth_id = auth.uid()
        AND (u.role = 'admin' OR u.city = guard_uploads.city)
    )
  );

-- guard_uploads: managers can insert for their city
CREATE POLICY guard_uploads_insert ON guard_uploads
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM app_users u
      WHERE u.auth_id = auth.uid()
        AND (u.role = 'admin' OR u.city = guard_uploads.city)
    )
  );


-- ────────────────────────────────────────────────────────────────────────────
-- 9. updated_at auto-trigger
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_app_users_updated_at
  BEFORE UPDATE ON app_users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_variances_updated_at
  BEFORE UPDATE ON variances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ────────────────────────────────────────────────────────────────────────────
-- 10. Seed data — default admin user
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO app_users (email, name, role, city, status)
VALUES
  ('admin@cityfurnish.com',             'Admin User',    'admin',   NULL,        'active'),
  ('delhi.manager@cityfurnish.com',     'Rajesh Kumar',  'manager', 'DELHI',     'active'),
  ('mumbai.manager@cityfurnish.com',    'Amit Sharma',   'manager', 'MUMBAI',    'active'),
  ('pune.manager@cityfurnish.com',      'Rohan Khanna',  'manager', 'PUNE',      'active'),
  ('hydrabad.manager@cityfurnish.com',  'Sneha Joshi',   'manager', 'HYDRABAD',  'active'),
  ('bangalore.manager@cityfurnish.com', 'Vikram Patel',  'manager', 'BANGALORE', 'active')
ON CONFLICT (email) DO NOTHING;
