# Cityfurnish Auto-Reco — Implementation Plan

> Last updated: 2026-07-14  
> Status: Phase 1 complete → Phase 2 next

---

## A. Source Column Maps

All 4 data sources feed into one unified `SourceRow` type. This table maps the raw column names from each source to the engine field.

### A1. Delivery Tracker (DT) — MongoDB

| DT Field | Engine Field | Notes |
|----------|-------------|-------|
| `scheduledDate` | `date` | IST date; used for run-date derivation |
| `items[].barcode` | `barcode` | Canonicalised by `barcode.ts` |
| `items[].status` | `status` | Done-only filter: status = `"2"` |
| `items[].jobType` / `orderType` | `jobType` | Normalised to NEW_RENTAL / REPLACE / REPAIR |
| `soNumber` / `orderNumber` | `soNumber` | SO reference |
| `ticketId` | `ticketId` | Desk ticket ID |
| `customerName` | `customer` | Customer name |
| `items[].productName` | `product` | Item description |
| City derived from task address | `city` | Mapped via DB MODEL.md §20 |
| Derived from `jobType` + `orderType` | `direction` | 6-rule priority switch (DB MODEL.md §14) |
| Source constant | `source` | `"DT"` |

**Critical rule:** Only rows where `items[].status = "2"` (Done) are ingested. All other statuses are dropped before the engine.

### A2. Odoo ERP — Postgres / JSON-RPC

| Odoo Field | Engine Field | Notes |
|-----------|-------------|-------|
| `move_line.lot_id.name` | `barcode` | Serial/lot number = barcode |
| `move_line.date` | `date` / `movementDate` | UTC → IST window per city |
| `move_line.move_id.date` | `createdOn` | Used for Odoo date windowing |
| `picking_type_code` | `direction` | `incoming` → IN, `outgoing` → OUT |
| `move_line.state` | `status` | Filter: `state = 'done'` only |
| `picking.origin` | `soNumber` | Sale order reference |
| `picking.partner_id.name` | `customer` | Customer name |
| `product.name` | `product` | Product description |
| `move_line.move_id.job_type` | `jobType` | REPAIR / REPLACE / NEW_RENTAL |
| Warehouse location code | `city` | Mapped via DB MODEL.md §8 (warehouse → city) |
| Source constant | `source` | `"ODOO"` |

### A3. Warehouse Google Sheet — Sheets API v4

| Sheet Column | Engine Field | Notes |
|-------------|-------------|-------|
| `Date` | `date` | Physical movement date |
| `Barcode` | `barcode` | Raw barcode string |
| `SO Number` | `soNumber` | Sale order |
| `Ticket ID` | `ticketId` | Support ticket |
| `Customer Name` | `customer` | Customer name |
| `SKU` | `product` | Item code / SKU |
| `Ops Type` | `direction` / `jobType` | Delivery/Pickup → OUT/IN |
| `Physical Status` | `status` | `done` if row exists |
| `Verified By` | — | Metadata only, not sent to engine |
| `PO Number`, `Vendor Name` | `raw` | Stored in raw JSONB |
| Sheet ID → city mapping | `city` | Config-driven (1 sheet per city) |
| Source constant | `source` | `"SHEET"` |

### A4. Guard Register — Excel / OCR Upload

| Guard Column | Engine Field | Notes |
|-------------|-------------|-------|
| `Date` | `date` | Physical gate date |
| `Barcode/ID` | `barcode` | Gate-scanned barcode |
| `SO Number` | `soNumber` | SO reference |
| `Ticket ID` | `ticketId` | Support ticket |
| `Customer Name` | `customer` | Customer name |
| `Product Name` | `product` | Item description |
| `Ops Type` | `direction` | Delivery → OUT, Pickup → IN |
| `Vehicle No` | `raw` | Stored in raw JSONB |
| `Source Page` | `raw` | OCR page reference |
| Upload metadata (city, direction) | `city` | User-selected at upload time |
| Source constant | `source` | `"PHYSICAL"` |
| Always set to `"done"` | `status` | Guard logged it = gate passed |

---

## B. Unified Frontend Columns

The 8 columns the user cares about, plus the operational columns that stay:

| # | Column | Source Field | Notes |
|---|--------|-------------|-------|
| 1 | **DATE** | `variances.date` | Movement date from source row |
| 2 | **CITY** | `variances.city` | DELHI / MUMBAI / PUNE / HYDRABAD / BANGALORE |
| 3 | **ITEM NAME** | `variances.product` | Product/item description |
| 4 | **BARCODE** | `variances.barcode` | Canonical barcode |
| 5 | **TICKET ID** | `variances.ticket_id` | Zoho Desk ticket |
| 6 | **SOURCE** | `variances.variance_source` | Odoo / DT / Sheet / Physical / Cross (colour badge) |
| 7 | **OPS TYPE** | `variances.job_type` | NEW_RENTAL / REPLACE / REPAIR / PICKUP |
| 8 | **SO NUMBER** | `variances.so_number` | Sale order number |
| — | **VARIANCE** | `variances.variance_name` | Engine rule that fired |
| — | **PRIORITY** | `variances.priority` | High / Medium / Info |
| — | **STATUS** | `variances.status` | open / in_progress / closed |
| — | **ACTION** | — | Close / Dispute button |

### Source Badge Colours

```
Odoo     → purple
DT       → blue
Sheet    → green
Physical → orange
Cross    → red
```

---

## C. Supabase Schema

Six tables. Full SQL is in `supabase/migrations/0001_init.sql`.

### C1. `app_users`

```sql
id          UUID PRIMARY KEY
auth_id     UUID UNIQUE          -- Supabase auth.users FK
email       TEXT UNIQUE NOT NULL
name        TEXT NOT NULL
role        TEXT                 -- 'admin' | 'manager' | 'viewer'
city        TEXT                 -- NULL for admins; engine city code for managers
status      TEXT                 -- 'active' | 'inactive'
created_at  TIMESTAMPTZ
updated_at  TIMESTAMPTZ
```

### C2. `reconciliation_runs`

```sql
id              UUID PRIMARY KEY
business_date   DATE NOT NULL
run_date        TEXT              -- engine-derived (may differ from business_date)
trigger         TEXT              -- 'cron' | 'manual'
triggered_by    TEXT              -- user email or 'system'
status          TEXT              -- 'running' | 'success' | 'partial' | 'failed'
total           INT
real_count      INT
info_count      INT
high_priority   INT
by_variance     JSONB             -- map of variance_name → count
warnings        JSONB
created_at      TIMESTAMPTZ
completed_at    TIMESTAMPTZ

-- Unique: only one success/partial per business_date
UNIQUE INDEX on (business_date) WHERE status IN ('success','partial')
```

### C3. `source_rows` *(pruned at 7 days)*

```sql
id              UUID PRIMARY KEY
run_id          UUID → reconciliation_runs
business_date   DATE
source          TEXT              -- 'PHYSICAL' | 'SHEET' | 'DT' | 'ODOO'
city            TEXT
direction       TEXT              -- 'IN' | 'OUT'
barcode         TEXT
status          TEXT
so_number       TEXT
ticket_id       TEXT
customer        TEXT
product         TEXT
job_type        TEXT
date            TEXT
created_on      TEXT
movement_date   TEXT
raw             JSONB             -- full source payload
```

### C4. `variances` *(dedup key + human resolution)*

```sql
id                UUID PRIMARY KEY
run_id            UUID → reconciliation_runs
business_date     DATE
city              TEXT
direction         TEXT              -- 'IN' | 'OUT' | 'CROSS'
barcode           TEXT
variance_name     TEXT

-- Engine-derived (refreshed on re-run)
priority          TEXT              -- 'High' | 'Medium' | 'Info'
original_priority TEXT
bucket            TEXT              -- 'REAL' | 'INFO'
dampened          BOOLEAN
responsible       TEXT
variance_source   TEXT              -- 'Odoo' | 'DT' | 'Sheet' | 'Physical' | 'Cross'
note              TEXT
ticket_id         TEXT
so_number         TEXT
customer          TEXT
product           TEXT
job_type          TEXT
date              TEXT
first_seen_at     TIMESTAMPTZ
last_seen_at      TIMESTAMPTZ

-- Human resolution — NEVER overwritten on re-run
status            TEXT DEFAULT 'open'   -- 'open' | 'in_progress' | 'closed'
closed_by         UUID → app_users
closed_at         TIMESTAMPTZ
closure_reason    TEXT
closure_note      TEXT

UNIQUE (business_date, city, direction, barcode, variance_name)
```

> **Critical upsert rule:** On re-run, the engine refreshes all engine-derived columns but the `ON CONFLICT DO UPDATE SET` clause **never includes** `status`, `closed_by`, `closed_at`, `closure_reason`, `closure_note`, or `first_seen_at`. Human decisions survive every re-run.

### C5. `ingestion_logs`

```sql
id            UUID PRIMARY KEY
run_id        UUID → reconciliation_runs
source        TEXT              -- 'PHYSICAL' | 'SHEET' | 'DT' | 'ODOO'
status        TEXT              -- 'OK' | 'FAILED'
rows_pulled   INT
message       TEXT
started_at    TIMESTAMPTZ
finished_at   TIMESTAMPTZ
duration_ms   INT
```

### C6. `guard_uploads`

```sql
id              UUID PRIMARY KEY
run_id          UUID → reconciliation_runs (nullable)
uploaded_by     UUID → app_users
file_name       TEXT
file_path       TEXT              -- Supabase Storage path
city            TEXT
business_date   DATE
direction       TEXT              -- 'IN' | 'OUT'
rows_parsed     INT
rows_valid      INT
ocr_confidence  REAL
status          TEXT              -- 'pending' | 'processed' | 'failed'
error           TEXT
```

### C7. `prune_expired()` Function

```sql
-- Runs at end of every reconciliation pipeline
-- source_rows older than 7 days
-- closed variances older than 90 days
-- failed runs older than 30 days
```

### RLS Summary

| Table | Admin | Manager | Service Role |
|-------|-------|---------|-------------|
| `app_users` | All rows | Own row only | Bypass |
| `reconciliation_runs` | Read all | Read all | Bypass |
| `source_rows` | All cities | Own city | Bypass |
| `variances` | All cities, R+W | Own city, R+W | Bypass |
| `ingestion_logs` | Read all | Read all | Bypass |
| `guard_uploads` | All cities, R+W | Own city, R+W | Bypass |

---

## D. Backend Pipeline

```
Trigger (cron 3 AM IST or manual POST)
  → createRun() — writes reconciliation_runs row (status: running)
  → pullAll() — 4 connectors in parallel, fault-tolerant
      ├─ DT connector    (MongoDB, Done-only filter)
      ├─ Odoo connector  (Postgres/JSON-RPC, state=done, IST window)
      ├─ Sheets connector (Google Sheets API v4, 5 city sheets)
      └─ Guard connector  (latest uploaded Excel for that date)
  → validateRows() — Zod schema, drops malformed rows (logs dropped count)
  → normalizeCity() — maps raw city strings to engine City union
  → saveSourceRows() — chunked insert to source_rows (1000 rows/chunk)
  → runAllCities() — engine: 14-rule ladder per city
  → upsertVariances() — ON CONFLICT dedup key, preserves human closures
  → saveIngestionLogs() — per-connector OK/FAILED + duration
  → finalizeRun() — status = success | partial | failed, aggregate counts
  → prune_expired() — retention backstop
```

### Connector Details

#### DT (`lib/connectors/dt.ts`)
- Transport: MongoDB Atlas (direct) or Metabase API
- Query: Aggregation pipeline from DB MODEL.md §18
- Filters: `scheduledDate` in IST range, `items.status = "2"` (Done-only), exclude B2B / New-Buy / Order-Transfer, exclude cityfurnish test tasks
- City normalise: DB MODEL.md §20 alias map
- Direction: 6-rule priority switch (DB MODEL.md §14)

#### Odoo (`lib/connectors/odoo.ts`)
- Transport: JSON-RPC or direct Postgres (TBD — see DB MODEL.md §23a)
- Filters: `state = 'done'`, date in IST range, company = Cityfurnish
- City normalise: DB MODEL.md §8 warehouse code → city map
- Odoo date windowing: per-city rules in `lib/engine/odoo-window.ts`

#### Sheets (`lib/connectors/sheets.ts`)
- Transport: Google Sheets API v4
- Config: 5 sheet IDs (one per city), each with IN + OUT data
- Direction: derived from `Ops Type` column or tab name

#### Guard (`lib/connectors/guard.ts`)
- Transport: Excel/CSV upload parsed server-side (ExcelJS)
- City + direction: from upload metadata (user selects at upload)
- Status: always `"done"` — guard logged it means it passed the gate

---

## E. API Routes

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| GET/POST | `/api/cron/reconcile` | Trigger full reconciliation pipeline | `CRON_SECRET` bearer |
| GET | `/api/runs` | List runs with date/status filters | Supabase RLS |
| GET | `/api/variances` | List variances — filters: city, date, bucket, source, priority, status, direction | Supabase RLS |
| PATCH | `/api/variances/[id]` | Close / dispute / reopen a variance | Supabase RLS |
| GET | `/api/sources` | Source rows for a run (drilldown) | Supabase RLS |
| POST | `/api/uploads/guard` | Upload guard register file | Supabase RLS |
| GET | `/api/stats/summary` | Dashboard KPI stats — replaces hardcoded `OVERALL` | Supabase RLS |

---

## F. Frontend Changes

### What Gets Replaced

| Current (Sample Data) | New (Real Data) |
|----------------------|----------------|
| `VarianceRow` with `itemCode`, `odooQty`, `dtQty`, `sheetQty`, `guardQty`, `delta` | `VarianceDB` with `date`, `city`, `product`, `barcode`, `ticket_id`, `variance_source`, `job_type`, `so_number` |
| Table headers: Item Code, Item Name, City, Odoo Qty, DT Qty, Sheet Qty, Guard Qty, Delta, Severity | Headers: DATE, CITY, ITEM NAME, BARCODE, TICKET ID, SOURCE, OPS TYPE, SO NUMBER, VARIANCE, PRIORITY |
| `demo-store.tsx` in-memory state | React Query hooks → `/api/variances` |
| Hardcoded `CITY_SUMMARIES`, `OVERALL` | `/api/stats/summary` |
| Severity filter (HIGH / MEDIUM / LOW) | Priority filter (High / Info) + Bucket filter (REAL / INFO) |
| CSV export with qty columns | CSV export with 8 unified columns |

### What Stays

- City tabs (ALL / per-city)
- City-wise breakdown cards (rewired to real data)
- Pagination
- Close variance modal (update API call target)
- RunResultsPanel (engine output display)
- Theme toggle, sidebar, layout
- Analytics, Uploads, System Health pages (rewired to Supabase)

---

## G. Implementation Phases

### Phase 1 — Supabase Migration + Schema ✅ DONE
- `supabase/migrations/0001_init.sql` — all 6 tables, indexes, RLS, prune function
- `lib/supabase/admin.ts` — service-role client
- `lib/supabase/client.ts` — browser-side anon client
- `lib/db/schema.ts` — TypeScript interfaces
- `lib/db/persist.ts` — fixed 4 column mapping issues

**To deploy:** Run `0001_init.sql` in Supabase SQL Editor.  
**Env vars needed:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`

---

### Phase 2 — DB Layer + API Routes
Files to create:

- `app/api/variances/route.ts` — GET with filters (city, date, bucket, source, priority, status)
- `app/api/variances/[id]/route.ts` — PATCH close/dispute/reopen
- `app/api/runs/route.ts` — GET list of reconciliation runs
- `app/api/stats/summary/route.ts` — KPI aggregates for dashboard
- `app/api/sources/route.ts` — source rows drilldown

Minor change to `lib/db/persist.ts` — already complete in Phase 1.

---

### Phase 3 — Frontend Column Swap
Files to update:

- `app/(dashboard)/dashboard/admin-dashboard.tsx` — replace 11 old columns with 8 new + operational
- `app/(dashboard)/dashboard/manager-dashboard.tsx` — same swap
- Replace `demo-store.tsx` variance state with React Query → `/api/variances`
- New `components/source-badge.tsx` — coloured pill component
- New filter dropdowns: bucket (REAL/INFO), source (Odoo/DT/Sheet/Physical/Cross)
- Rewire CSV export function to new columns

---

### Phase 4 — Connectors: DT + Odoo
Files to implement (currently stubs):

- `lib/connectors/dt.ts` — MongoDB aggregation from DB MODEL.md §18
  - Done-only filter (`items.status = "2"`)
  - City normalisation (§20 map)
  - Direction logic (§14 priority switch)
- `lib/connectors/odoo.ts` — transport TBD (JSON-RPC vs Postgres vs Metabase)
  - Per-city date windowing (already in `lib/engine/odoo-window.ts`)
  - City normalisation (§8 warehouse code map)

**Blockers:** Odoo transport decision + credentials

---

### Phase 5 — Connectors: GSheet + Guard
Files to implement:

- `lib/connectors/sheets.ts` — Google Sheets API v4
  - 5 sheet IDs (one per city) from n8n config
  - Column map from §A3 above
- `lib/connectors/guard.ts` — ExcelJS parser
  - Column map from §A4 above
  - Pulls latest `guard_uploads` row for the run date
- Update uploads page to write to `guard_uploads` table

**Blockers:** Google service account key + 5 sheet IDs, sample guard register `.xlsx`

---

### Phase 6 — Integration + Rewire Remaining Pages
- Rewire Analytics page from `CITY_SUMMARIES` sample data → Supabase aggregates
- Rewire System Health page from `CONNECTORS` / `ERROR_LOGS` → `ingestion_logs`
- Rewire Leaderboard from sample data → real accuracy scores
- Rewire Email Digest from sample data → real run summary
- Add date picker to dashboard (defaults to today)
- Wire "Run Reconciliation" button → `POST /api/cron/reconcile`
- End-to-end test with one city (BANGALORE) using real DT + Odoo data

---

## H. Files — Unchanged vs Rewritten

### Stays Untouched (engine is frozen)

- `lib/engine/*` — all 13 engine files
- `lib/connectors/types.ts` — CityTaggedRow, Connector interface
- `lib/connectors/index.ts` — orchestrator (pullAll)
- `lib/validation/source-row.ts` — Zod schema
- `app/api/cron/reconcile/route.ts` — pipeline structure
- Layout, sidebar, theme, login, fonts

### Gets Replaced / Rewritten

- `lib/sample-data.ts` — VARIANCES array + VarianceRow type removed; CITIES kept
- `lib/demo-store.tsx` — replaced by React Query hooks
- `admin-dashboard.tsx` — table columns + data binding
- `manager-dashboard.tsx` — table columns + data binding
- `lib/connectors/dt.ts` — stub → real implementation
- `lib/connectors/odoo.ts` — stub → real implementation
- `lib/connectors/sheets.ts` — stub → real implementation
- `lib/connectors/guard.ts` — stub → real implementation
- CSV export function

---

## I. Environment Variables

All vars go in `.env.local` (gitignored). See `.env.example` for the full list.

```
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://blcdwadfsfuqaamzpcsw.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_...
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...       # needed for Phase 2+

# DT (MongoDB)
DT_MONGODB_URI=mongodb+srv://...               # store URI only, never commit
DT_MONGODB_DB=cityfurnish

# Odoo (fill when transport is decided)
ODOO_URL=
ODOO_DB=
ODOO_USERNAME=
ODOO_API_KEY=

# Google Sheets (Phase 5)
GOOGLE_SERVICE_ACCOUNT_KEY=                    # base64-encoded service account JSON

# Cron
CRON_SECRET=                                   # random secret matching scheduler header
```

> **Security reminder:** Rotate the MongoDB `atlasAdmin` password before go-live. The current password in the connection string is for development only.

---

## J. Open Decisions

| Decision | Status | Notes |
|---------|--------|-------|
| Odoo transport: JSON-RPC vs direct Postgres vs Metabase | ⏳ Pending | Metabase confirmed accessible; direct Postgres preferred for speed |
| Google Sheets sheet IDs (5 cities) | ⏳ Pending | Available in n8n workflow config |
| Guard OCR provider | ⏳ Pending | Google Vision vs AWS Textract |
| Vercel plan for max cron duration | ⏳ Pending | Hobby = 60s max; Pro = 300s |
