# Supabase Backend + Reconciliation Pipeline — Implementation Plan

> Approved plan for standing up the Supabase database and the cron-driven ingestion +
> reconciliation backend. Companion progress tracker: [PHASE_STATUS.md](./PHASE_STATUS.md).

## Context

The app currently runs entirely in **demo mode**: auth is a signed cookie, all data lives
in a localStorage React context (`lib/demo-store.tsx`), and "Run Reconciliation" executes
the engine client-side over hand-built sample rows. Nothing is persisted or shared across
users/devices, and no real data is ingested.

The reconciliation **engine itself is done and tested** (`lib/engine/*`, `runAllCities()`),
and the three Supabase client factories already exist (`lib/supabase/{client,server,admin}.ts`).
What's missing is everything around it: the database, the ingestion connectors, the scheduled
pipeline, and repointing the dashboard from the demo store to real data.

**Goal:** stand up the Supabase database and a cron-driven backend that, once per run, pulls
from all 4 sources (DT/Mongo, Odoo, Google Sheet, Guard OCR), runs the existing engine,
persists the variances, and serves them to the dashboard — with closed variances archived
(hidden from the dashboard but kept forever) and raw source data pruned after 7 days.

### Decisions locked with the user
- **Odoo:** connector behind a generic `pull()` interface; Postgres-vs-JSON-RPC transport decided later.
- **Guard:** true image OCR (scanned register → Storage → OCR provider → rows); provider abstracted.
- **Retention:** keep ALL variances forever (closed ones hidden from dashboard); dashboard shows
  only `OPEN`/`DISPUTED` from the last 7 days; prune bulky raw `source_rows` after 7 days.
- **Variance dashboard columns:** Product name, Barcode, **Source label**, Ticket ID, **Reason**
  — plus city/priority/status. All derivable from the engine's `VarianceRowOut`.

---

## Prerequisites / blockers (resolve before or during build)

1. **Secret API key needed.** Only the publishable key (`sb_publishable_dAiiGx_...`) was provided.
   Server-side cron writes must bypass RLS and need the **secret** key (`sb_secret_...`) from
   Supabase → Settings → API keys.
2. **Env var mapping.** The code reads `NEXT_PUBLIC_SUPABASE_ANON_KEY` and
   `SUPABASE_SERVICE_ROLE_KEY`. The new-format keys are drop-in compatible with `supabase-js`
   — just populate `.env.local`:
   - `NEXT_PUBLIC_SUPABASE_URL=<your-project>.supabase.co`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_...`  (put the real value only in `.env.local`)
   - `SUPABASE_SERVICE_ROLE_KEY=sb_secret_...` (to obtain)
   - `CRON_SECRET=<random>`
   (No code change to the client files needed — only values.)
3. **New npm deps:** `mongodb` (DT). Later: `pg` **or** an Odoo RPC client (per deferred
   choice), and an OCR SDK (`@google-cloud/vision` / AWS Textract / `tesseract.js`) once the
   provider is chosen.
4. **Cron host:** the engine is TypeScript and must run in a **Next.js Node route**
   (`app/api/cron/reconcile`). Schedule it with **Vercel Cron** (or any external scheduler)
   POSTing to that route with the `CRON_SECRET`. Supabase pg_cron alone cannot run the TS engine.

---

## Database schema (`supabase/migrations/0001_init.sql`)

All tables use `gen_random_uuid()` PKs and `timestamptz` timestamps. City stored as text to
match the engine's `City` union (`DELHI|MUMBAI|PUNE|HYDRABAD|BANGALORE` — note the existing
`HYDRABAD` spelling). Status/role/etc. enforced with `CHECK` constraints (simpler than PG enums).

### 1. `app_users` — replaces `PLATFORM_USERS` + demo-auth
`id uuid PK REFERENCES auth.users(id)`, `name`, `email unique`, `role CHECK (ADMIN|MANAGER)`,
`city text NULL`, `status default 'ACTIVE'`. Feeds `lib/session.ts` (which currently hardcodes
every authed user to ADMIN) and the `/users` page.

### 2. `reconciliation_runs` — one row per pipeline execution
`id`, `run_date date` (engine-derived business date), `ran_at`, `status CHECK
(running|success|partial|failed)`, `total int`, `real_count int`, `info_count int`,
`high_priority int`, `by_variance jsonb`, `warnings jsonb`, `trigger text` (cron|manual),
`triggered_by text NULL`. Mirrors `MultiCityRun.combined` + `CityRunResult.summary`.

### 3. `variances` — CORE table (one row per engine `VarianceRowOut`, deduped)
Columns map 1:1 to `VarianceRowOut` plus resolution/audit + a derived `source`:
- `id`, `run_id FK`, `business_date date`
- `city`, `barcode`, `direction CHECK (IN|OUT|CROSS)`
- `variance_name text` (the **Reason**), `note text` (reason detail)
- `source text` — **derived source label** (Odoo/DT/Sheet/Physical/Cross), see below
- `priority CHECK (High|Medium|Info)`, `original_priority NULL`, `bucket CHECK (REAL|INFO)`,
  `dampened bool`, `responsible text` (owning team)
- `ticket_id NULL`, `so_number NULL`, `customer NULL`, `product NULL` (**Product name**), `job_type NULL`
- `status CHECK (OPEN|CLOSED|DISPUTED) default 'OPEN'`
- `closed_by NULL`, `closed_at NULL`, `closure_reason NULL`, `closure_note NULL`
- `first_seen_at default now()`, `last_seen_at default now()`
- **`UNIQUE (business_date, city, direction, barcode, variance_name)`** — the dedup key
- Indexes: `(status, business_date)`, `(city)`, `(run_id)`

**Derived `source`:** centralize the `SOURCE_OF` map that already exists in
`app/(dashboard)/analytics/page.tsx` into a small helper `lib/engine/variance-source.ts`
(`varianceSource(variance_name, direction) -> "Odoo"|"DT"|"Sheet"|"Physical"|"Cross"`), reuse it
both at persist time and in analytics.

### 4. `source_rows` — "complete data for all 4 sources" (normalized engine input; **pruned at 7 days**)
`id`, `run_id FK`, `business_date date`, `source CHECK (PHYSICAL|SHEET|DT|ODOO)`, `city`,
`direction`, `barcode`, `status`, `so_number`, `ticket_id`, `customer`, `product`, `job_type`,
`date text`, `created_on text`, `movement_date text`, `raw jsonb` (original document),
`created_at`. Exactly the `SourceRow` shape so a run can be re-reconciled without re-pulling.

### 5. `ingestion_logs` — per-source per-run health (powers System Health page)
`id`, `run_id FK NULL`, `source`, `city NULL`, `status CHECK
(OK|FAILED|DEGRADED|RETRYING|RESOLVED)`, `rows_pulled NULL`, `message NULL`, `started_at`,
`finished_at`, `duration_ms`. Replaces the sample `CONNECTORS` + `ERROR_LOGS`.

### 6. `guard_uploads` — OCR upload tracking (mirrors `GuardUpload`)
`id`, `city`, `upload_date date`, `file_name`, `storage_path`, `status CHECK
(PENDING|UPLOADED|OCR_RUNNING|PARSED|ERROR)`, `uploaded_by`, `rows NULL`,
`ocr_confidence numeric NULL`, `error NULL`, `created_at`.

### Storage
Private bucket **`guard-registers`** for scanned guard images/PDFs.

### Retention function + schedule
SQL function `prune_expired()`: `DELETE FROM source_rows WHERE business_date < current_date - 7;`
(+ optionally trim old `ingestion_logs`). **`variances` are never purged.** Schedule nightly via
Supabase **pg_cron**, and also call it as the final step of the reconcile route as a backstop.

### RLS policies
- `app_users`: select own row; ADMIN selects all.
- `variances`: ADMIN full; MANAGER select/update **where `city` = their city**.
- `guard_uploads`: MANAGER insert/select own city; ADMIN all.
- `reconciliation_runs` / `source_rows` / `ingestion_logs`: read for authed (managers scoped
  where a city column exists); **all writes only via the secret-key admin client** (cron).

---

## Backend pipeline

### Connectors (`lib/connectors/`) — uniform interface
Each exports `pull(runDate: string): Promise<SourceRow[]>` returning normalized `SourceRow[]`
(the exact engine-input shape from `lib/engine/types.ts`):
- **`dt.ts`** — MongoDB (`mongodb` driver, `cityfurnish` DB, the connection string already
  tested). Map DT docs → `SourceRow{ source:'DT', direction, barcode, status, ... }`.
- **`odoo.ts`** — **generic interface now**, transport (pg / JSON-RPC) filled in later. Map
  stock moves → `SourceRow{ source:'ODOO', createdOn, jobType, ... }`.
- **`sheets.ts`** — Google Sheets API (`googleapis`, `GOOGLE_SERVICE_ACCOUNT_KEY`) →
  `SourceRow{ source:'SHEET' }`.
- **`guard.ts`** — read image/PDF from `guard-registers` Storage → OCR provider (abstracted
  behind `ocr(buffer) -> rows`) → `SourceRow{ source:'PHYSICAL' }` + confidence.
- **`index.ts`** — orchestrator: run all 4 with `Promise.allSettled`, tag each row's city,
  merge into `Record<City, SourceRow[]>`, write an `ingestion_logs` row per source, tolerate
  partial failure (run marked `partial`).

### Validation (`lib/validation/`)
Zod (v4, installed) schemas per source raw shape → `SourceRow`, applied inside each connector so
malformed data never reaches the engine.

### Reconcile route — `app/api/cron/reconcile/route.ts` (Node runtime)
Already excluded from middleware auth (`api/cron` matcher). Steps:
1. Verify `Authorization: Bearer ${CRON_SECRET}`.
2. Insert `reconciliation_runs` (status=`running`).
3. `connectors/index.pull()` → `Record<City, SourceRow[]>`; log ingestion per source.
4. Bulk-insert `source_rows` (the complete raw feed).
5. `runAllCities(rowsByCity)` (existing engine, unchanged).
6. Per `VarianceRowOut`: compute `source` via `varianceSource()`, **upsert** into `variances`
   on the unique key — **SET only engine-derived columns + `last_seen_at`/`run_id`; never touch
   `status`/closure columns** (so a re-run refreshes detail but a human's CLOSE/DISPUTE sticks
   and closed items never reopen).
7. Update `reconciliation_runs` (success/partial, totals, `by_variance`, warnings).
8. Call `prune_expired()`.
All writes use `createAdminClient()` (secret key).

### Manual trigger
Repoint the sidebar **"Run Reconciliation"** button (`app/(dashboard)/sidebar.tsx`, currently a
client-side demo run) to POST an admin-only server action that invokes the same pipeline.

---

## Dashboard / frontend rewiring

- **Reads:** server components/route handlers query `variances WHERE status IN ('OPEN','DISPUTED')
  AND business_date >= current_date - 7`, RLS-scoped (managers see own city only).
- **Variance table columns** (per spec): **Product** (`product`), **Barcode** (`barcode`),
  **Source** (`source`), **Ticket ID** (`ticket_id`), **Reason** (`variance_name`, with `note`
  as tooltip/detail) — plus City, Priority, Status, Direction. Applies to
  `app/(dashboard)/dashboard/admin-dashboard.tsx` and `manager-dashboard.tsx` (replace the
  quantity-based `odooQty/dtQty/...` columns).
- **Close/Dispute:** `close-variance-modal.tsx` → server action updating the `variances` row
  (`status`, `closure_reason`, `closure_note`, `closed_by`, `closed_at`). Closed rows drop off
  the dashboard (filter) but remain in the table forever.
- **System Health** (`system-health/page.tsx`) → reads `ingestion_logs` (+ a latest-per-source
  connector-status view) instead of sample `CONNECTORS`/`ERROR_LOGS`.
- **Guard Upload** (`uploads/uploads-client.tsx`) → upload file to `guard-registers` Storage,
  insert `guard_uploads`, kick off OCR; reflect status transitions.
- **`lib/demo-store.tsx`:** keep as the fallback when `supabaseConfigured` is false; when
  configured, dashboards read from Supabase (Server Components) and mutations go through server
  actions. `lib/session.ts` starts reading `app_users` for real role/city instead of the ADMIN stub.

---

## Migration / apply strategy
- Write `supabase/migrations/0001_init.sql` (tables, indexes, checks, RLS, storage bucket,
  `prune_expired()`, pg_cron schedule). Apply via `supabase db push` (CLI) or the SQL editor.
- Seed `app_users` with the 6 existing accounts (mapped to Supabase Auth users).

---

## Verification (end-to-end)
1. **Migrations:** apply SQL; confirm all 6 tables + `guard-registers` bucket + RLS exist in the
   Supabase dashboard.
2. **Pipeline:** with `.env.local` populated (incl. secret key + `CRON_SECRET`), `curl -X POST
   -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/reconcile` → assert rows land
   in `reconciliation_runs`, `variances`, `source_rows`, `ingestion_logs`.
3. **Dedup/closure:** run the route twice for the same day → no duplicate variances (upsert). Close
   one variance in the UI, re-run → it stays CLOSED and off the dashboard, still present in `variances`.
4. **RLS:** log in as a city MANAGER → dashboard shows only that city's OPEN/DISPUTED variances
   with the 5 required columns; ADMIN sees all.
5. **Retention:** insert a `source_rows` row at `business_date = today-8`, run `prune_expired()` →
   deleted; a `variances` row older than 7 days → still in DB but absent from the dashboard query.
6. **Regression:** `npx vitest run` (engine tests) and `npm run build` stay green.

---

## Suggested build order
1. Migrations + RLS + storage + `app_users` seed. **(unblocks everything)**
2. `lib/engine/variance-source.ts` helper (extract `SOURCE_OF`).
3. Reconcile route + connector orchestrator with **DT + Sheets live**, Odoo/Guard stubbed.
4. Persistence (runs/variances upsert/source_rows/ingestion_logs) + `prune_expired()`.
5. Repoint dashboard reads + close/dispute server actions to Supabase (behind `supabaseConfigured`).
6. Guard OCR connector + upload-to-Storage flow (once OCR provider chosen).
7. Odoo connector transport (once pg-vs-RPC decided).
8. Vercel Cron schedule + System Health + Email digest wiring.
