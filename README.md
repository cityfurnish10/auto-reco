# Cityfurnish Auto-Reconciliation Platform

Nightly warehouse stock reconciliation across **5 cities** (Delhi, Mumbai, Pune,
Hyderabad, Bangalore). Every night it pulls the day's movements from **four
independent sources**, compares them barcode-by-barcode, and raises **variances**
for managers to chase — with a leaderboard, analytics, a daily digest email, and
system-health monitoring on top.

- **Live:** deployed on Vercel · reconciles at **00:30 IST** (D-1)
- **Repo:** `github.com/cityfurnish10/auto-reco`

---

## Contents

1. [What it does](#what-it-does)
2. [Tech stack](#tech-stack)
3. [Architecture & data flow](#architecture--data-flow)
4. [The four sources](#the-four-sources)
5. [Reconciliation engine](#reconciliation-engine)
6. [Database](#database)
7. [Project structure](#project-structure)
8. [Environment variables](#environment-variables)
9. [Local development](#local-development)
10. [Deployment](#deployment)
11. [Security](#security)
12. [Roles & usage](#roles--usage)
13. [Guard register guidelines](#guard-register-guidelines)
14. [Scripts & testing](#scripts--testing)

---

## What it does

A reconciliation run (D-1 — reconciles the previous business day) pulls all four
sources, canonicalizes every barcode, and compares presence/status across sources
per direction (IN/OUT). Mismatches become **variances**, bucketed as:

- **REAL** — a genuine gap to chase (e.g. logged by ops & DT but not posted in Odoo).
- **INFO** — context only (posting lag, Odoo-only postings) — no action.

PP-boxes and consumables are **count-only** movements (tracked as counts, not
variances). The run persists results, updates the leaderboard/analytics rollup,
and emails a management digest.

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | **Next.js 16** (App Router, React 19), **TypeScript** |
| Styling | **Tailwind v4**, `lucide-react` icons, hand-built SVG/CSS charts (no chart lib) |
| Backend | Next.js **route handlers** (Node runtime) on Vercel serverless |
| Scheduling | **Vercel Cron** (`vercel.json`) — nightly OCR + reconcile |
| Database / Auth / Storage | **Supabase** — Postgres + Row-Level Security, Auth, Storage |
| DB clients | `@supabase/ssr` cookie client (RLS-scoped) + server-only service-role admin client |
| Movement Sheet | Google Sheets API (`googleapis`, service account) |
| Odoo (ERP) | **Metabase REST** — native SQL over `stock_move_line` |
| Delivery Tracker | **MongoDB** driver (`deliveries` collection) |
| Guard register OCR | **Azure Document Intelligence** (`prebuilt-layout`) |
| Email | **Nodemailer** over Gmail SMTP (app password) |
| Validation / tests | **Zod**, **Vitest** |
| Deploy | Vercel (`bom1` region), GitHub → Vercel CI |

---

## Architecture & data flow

```
                         ┌── Google Sheets (movement sheet)
   nightly cron          ├── Metabase → Odoo (stock_move_line)
   /api/cron/reconcile ──┼── MongoDB (Delivery Tracker)
                         └── Supabase Storage (guard PDF) → Azure OCR
                                        │
                                        ▼
                          Reconciliation engine (lib/engine)
                          canonicalize → per-direction ladder → buckets
                                        │
                                        ▼
              Supabase: source_rows · variances · run_city_stats ·
                        ingestion_logs · reconciliation_runs · email_logs
                                        │
              ┌─────────────────────────┼─────────────────────────┐
              ▼                         ▼                          ▼
        Dashboards (RLS)          Digest email (Gmail)      Leaderboard / Analytics /
        admin + managers                                    System Health (admin)
```

**Crons** (`vercel.json`, IST): `00:00` `/api/cron/ocr` reads uploaded guard PDFs;
`00:30` `/api/cron/reconcile` pulls sources, runs the engine, persists, prunes,
and emails the digest. Both are protected by a `CRON_SECRET` bearer token.

---

## The four sources

Connectors live in `lib/connectors/` and all return a common `SourceRow[]`:

- **`sheets.ts`** — per-city Google Sheet "Movement Register" (Outward/Inward tabs).
- **`odoo.ts`** — Metabase native SQL over Odoo `stock_move_line` (windowed ±1 day for posting lag).
- **`dt.ts`** — MongoDB `deliveries` collection.
- **`guard.ts`** — reads OCR-processed guard rows; OCR itself is `ocr/document-intelligence.ts` + `ocr/process.ts`.

---

## Reconciliation engine

`lib/engine/` — a barcode-level, per-direction engine:

- **`barcode.ts`** — canonicalize (uppercase, strip whitespace, OCR-fold `O→0 I→1 S→5 Z→2 G→6`), validity, spare/PP detection.
- **`run.ts`** — orchestrator: derive run date, window Odoo, build IN/OUT universes, ladder-classify, count layer, per-city summary (incl. `movements`, `pp_box_count`, `consumable_count`).
- **`ladder.ts` / `buckets.ts` / `suppressions.ts`** — reported-source-aware classification, REAL/INFO bucketing, failed-delivery & repair suppression.
- Fully unit-tested (`tests/engine/`).

---

## Database

Supabase Postgres. Types mirror the tables in `lib/db/schema.ts`; writes go
through `lib/db/persist.ts` (service-role). **RLS is enabled on all data tables.**

| Table | Purpose |
|---|---|
| `app_users` | Users + role (`admin`/`manager`) + assigned `city`; linked to Supabase Auth by `auth_id`. |
| `reconciliation_runs` | One row per run — status, trigger, aggregate counts, `by_variance`. |
| `source_rows` | The raw pulled feed per run (all 4 sources). Pruned after **7 days**. |
| `variances` | The reconciliation output. Natural key `(business_date, city, direction, barcode, variance_name)`; human closures preserved across re-runs. Closed rows pruned after **90 days**. |
| `ingestion_logs` | One row per connector per run (status, rows, timing) — for System Health. |
| `guard_uploads` | Guard-register uploads + OCR state (`pending→processed`) + `parsed_rows`. |
| `run_city_stats` | Per-city rollup per run (`movements`, `real_count`, `pp_box_count`, `consumable_count`) — powers Leaderboard, Analytics, and the digest. Upsert on `(business_date, city)`. |
| `email_logs` | Audit of digest sends (`sent`/`skipped`/`failed`, recipients, message id). |

**Storage:** bucket `guard-registers` — guard PDFs at `{CITY}/{business_date}/{id}.pdf`.

**RLS & functions:** `auth_is_admin()` and `auth_city()` are `SECURITY DEFINER`
helpers (migration `0004`) that policies use — admins see all cities, a manager
sees only their own. `prune_expired()` enforces retention; `set_updated_at()` is a
trigger.

**Migrations** (`supabase/migrations/`, applied in the Supabase SQL editor):

```
0001_init                0005_run_city_stats
0002_seed_app_users      0006_rename_hyderabad
0003_guard_ocr_review    0007_email_logs
0004_fix_rls_recursion   0008_pp_consumable_counts
```

---

## Project structure

```
app/
  (auth)/login/            login page (light theme + CF logo)
  (dashboard)/             admin + manager dashboards, leaderboard, analytics,
                           system-health, uploads, email-digest, users
  api/
    cron/{reconcile,ocr}/  scheduled jobs (CRON_SECRET-gated)
    variances, stats/summary, leaderboard, analytics, system-health,
    users, uploads/guard, email/{test,preview}
lib/
  connectors/              sheets · odoo · dt · guard · ocr/*
  engine/                  reconciliation engine + types
  db/                      schema.ts · persist.ts · current-user.ts
  email/                   transport · digest (builder + HTML) · index
  supabase/                server (RLS) · admin (service-role) · client (browser)
  hooks/                   use-dashboard-data · use-leaderboard · use-analytics · …
supabase/migrations/       0001 … 0008
scripts/                   backfill-city-stats.mjs · rename-hyderabad-storage.mjs
tests/                     engine + connector unit tests (Vitest)
```

---

## Environment variables

Copy `.env.example` → `.env.local` (gitignored) and fill in. Grouped:

- **Supabase:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- **Google Sheets:** `GOOGLE_SERVICE_ACCOUNT_KEY`, `SHEETS_CONFIG`
- **Odoo via Metabase:** `METABASE_URL`, `METABASE_API_KEY`, `METABASE_ODOO_DB_ID`
- **Delivery Tracker:** `DT_MONGODB_URI`, `DT_MONGODB_DB`, `DT_TASKS_COLLECTION`
- **Guard OCR:** `AZURE_VISION_ENDPOINT`, `AZURE_VISION_API_KEY`
- **Email:** `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `DIGEST_RECIPIENTS`
- **App:** `NEXT_PUBLIC_APP_URL` (stable domain — email logo + dashboard link), `CRON_SECRET`

> `NEXT_PUBLIC_*` ship to the browser by design — only the Supabase URL + **anon**
> key are public (RLS-protected). Every other secret is server-only.

---

## Local development

```bash
npm install
npm run dev          # http://localhost:3000
npm run build        # production build
npm test             # Vitest
npm run lint         # ESLint
```

Without Supabase configured, the app falls back to a **demo mode** (seeded local
accounts + sample data) so the UI is explorable offline.

---

## Deployment

1. **Vercel** — connect the GitHub repo; set all env vars (server-side, encrypted).
2. **Apply migrations** — run each `supabase/migrations/*.sql` in the Supabase SQL editor in order.
3. **Crons** — `vercel.json` registers `/api/cron/ocr` (00:00) and `/api/cron/reconcile` (00:30). Vercel sends the `CRON_SECRET` bearer automatically.
4. **Seed** — trigger a first reconcile (`POST /api/cron/reconcile?date=YYYY-MM-DD`) or run `scripts/backfill-city-stats.mjs`.

---

## Security

- **No secrets in the repo** — `.env.local` is gitignored and was never committed; only `.env.example` (placeholders) is tracked. Verified across full git history.
- **Service-role key** is read only in server route handlers + `lib/supabase/admin.ts`; never `NEXT_PUBLIC_`, never imported by a client component.
- **Browser** uses only the URL + anon key (RLS-protected).
- **Auth gates:** cron routes require the `CRON_SECRET` bearer; all other APIs require a session (`getCurrentAppUser` / `auth.getUser`); managers are RLS-scoped to their city; admin-only routes gated in `middleware.ts`.
- PII files (`*.xlsx/*.csv/*.pdf`) and `reports/` are gitignored.

---

## Roles & usage

- **Administrator** — full access, all cities: create/assign city managers (with an initial password) in **User Management**, view all variances, and use the Leaderboard, Analytics, System Health, and Email Digest screens.
- **City Manager** — one city only: view/search their variances (by barcode / ticket / SO), filter by date, and **close** variances with a reason. Also uploads their city's guard register and sees the Leaderboard.

Managers are provisioned by the admin (no self-registration). Closing a variance
updates the shared record, reflected on the admin dashboard.

---

## Guard register guidelines

The handwritten gate register is one of the four sources — it's scanned and read
by OCR, so legibility matters:

- **Keep Outward and Inward on separate pages** (the OCR reads the page heading for direction).
- **Never leave the barcode blank.** Write **one character per box**, upright and clear.
- **Distinguish look-alikes:** `0≠O`, `1≠I`, `5≠S`, `2≠Z`, `6≠G` (the engine folds these, but clear writing beats a guess).
- Log **PP boxes / consumables as counts** in the totals section.
- **Upload** a clean single PDF (all pages, flat scan, ≤20 MB) via **Uploads → your city** by **22:00 IST**; it's OCR'd automatically overnight.

---

## Scripts & testing

- `scripts/backfill-city-stats.mjs` — seed `run_city_stats` for pre-existing runs.
- `scripts/rename-hyderabad-storage.mjs` — one-off storage-path fixer (Hyderabad rename).
- `tests/` — engine & connector unit tests (`npm test`).

---

*Internal operations platform. Reconciles Delhi, Mumbai, Pune, Hyderabad &
Bangalore nightly across Odoo, the movement sheet, Delivery Tracker, and the guard
register.*
