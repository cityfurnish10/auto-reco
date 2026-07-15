# Project Phase Status — CityFurnish Auto-Reconciliation Platform

_Last updated: 2026-07-15 (reco-logic overhaul validated on real 12-July data: 727 false HIGHs → 85 real chase items)_

A running record of what's **done** and what's **to be done**. The detailed backend design lives
in [DB_Plan.md](./DB_Plan.md) (original plan) and [IMPLEMENTATION_PLAN_1.md](./IMPLEMENTATION_PLAN_1.md)
(current schema — the schema was revised after DB_Plan.md was written; IMPLEMENTATION_PLAN_1.md
+ the actual migration files are authoritative for exact column names/types).

**Legend:** ✅ done · 🟡 in progress / partial · ⬜ not started · 🔒 blocked (needs input/creds)

---

## Snapshot

| Phase | Area | Status |
|-------|------|--------|
| 0 | Reconciliation engine (core logic) | ✅ done |
| 1 | Demo-mode app (UI, auth, sample data) | ✅ done |
| 2 | Visual upgrade (design tokens, dark mode) | ✅ done |
| 3 | Lucide icon migration | ✅ done |
| 4 | Source connectivity verification (DT MongoDB) | ✅ done |
| 5 | Supabase database — schema live, 6 tables + RLS + 6 users, verified | ✅ **done, live** |
| 6 | API routes (variances/runs/stats/sources) | ✅ done (code) — testable now, not yet tested |
| 7 | Connectors (**DT + Sheets + Odoo all live-verified**; Guard OCR code+infra ready) | 🟢 3 of 4 sources live; Guard just needs a real sample PDF |
| 8 | Dashboard reads from Supabase + retention | ⬜ |
| 9 | Cron scheduling, System Health, Email digest | ⬜ |

---

## ✅ Phase 0 — Reconciliation Engine (pre-existing, complete)
- Full barcode-level, per-direction engine in `lib/engine/*` (run, ladder, buckets, suppressions,
  odoo-window, counts, direction-conflict, dates, barcode, views, util, types).
- Deterministic; per-city/per-direction; REAL vs INFO buckets; 14-rule variance ladder;
  suppressions; direction conflict; count layer.
- Test suite green: `tests/engine/engine.test.ts` (24 tests).
- **Nothing to do** — this is the source of truth the backend wraps.

## ✅ Phase 1 — Demo-mode Application (pre-existing, complete)
- Next.js 16 App Router, route groups `(auth)` / `(dashboard)`.
- Cookie-based demo auth (`lib/demo-auth.ts`), role gating in `middleware.ts`.
- localStorage-backed state (`lib/demo-store.tsx`); sample data (`lib/sample-data.ts`).
- Pages: dashboard (admin/manager), uploads, leaderboard, users, system-health, analytics,
  email-digest, login.
- Supabase client factories exist but unused (`lib/supabase/{client,server,admin}.ts`).

## ✅ Phase 2 — Visual Upgrade (this session, complete)
- Token system: `tailwind.config.ts` + `app/globals.css` (surfaces, accent, semantic status
  colors, text hierarchy, one border/shadow token, radius scale).
- Shared component classes: `.card`, `.kpi-tile`, `.badge`, `.chip`, `.btn*`, `.input-clean`, `.table-clean`.
- **Dark mode** added from scratch (pre-hydration script in `layout.tsx`, `theme-toggle.tsx`,
  `data-theme` on `<html>`, localStorage `cf-theme`).
- Fixed `borderRadius.full` bug (circles were rendering as rounded squares).
- Removed baked font-weights from `xl`/`2xl` tokens; `.font-headline` default weight → even headings.
- All dashboard pages restyled to the token system. Build/lint/tests green.

## ✅ Phase 3 — Lucide Icon Migration (this session, complete)
- Replaced all 67 Material Symbols (font ligatures that rendered as raw words when the font
  failed) with **Lucide SVG** components via `components/icon.tsx` wrapper.
- Removed the Material Symbols `@import` + CSS from `globals.css`.
- Installed `lucide-react`. Build/lint/tests green.
- Removed the Sync Latency Heatmap card from System Health (per request).

## ✅ Phase 4 — Source Connectivity Verification (this session, complete)
- **DT MongoDB (Atlas)** connection string tested and **working**: DNS + TCP 27017 reachable,
  TLS + auth (`atlasAdmin`/`authSource=admin`) succeeds, reads OK.
- Databases seen: `cityfurnish` (~1.87 GB — the real data), plus `admin`/`config`/`local`.
- ⚠️ Security follow-up: the DT password was shared in plaintext → **rotate `atlasAdmin`** before
  go-live; store the URI only in `.env.local` (never commit).
- ⏳ Open thread: list `cityfurnish` collections to locate the **movement-history** collection +
  fields (needed by the DT connector). Metabase is NOT connected in Claude (no tools exposed);
  the movement table physically lives in a source DB, so we'll read it directly.

---

## ✅ Phase 5 — Supabase Database + Ingestion Pipeline (LIVE — verified 2026-07-14)

**Schema note:** the schema in `supabase/migrations/0001_init.sql` was substantially rewritten
(by hand) from the original DB_Plan.md draft. Key differences now in effect — always check the
actual migration file, not DB_Plan.md, for exact shapes:
- `variances.status` is `open | in_progress | closed` (3 states, lowercase) — there is **no**
  separate "disputed" status; the API treats `dispute` as `in_progress`.
- Source label column is named **`variance_source`** (not `source`).
- Date columns split as `business_date` (DATE) + `run_date` (TEXT, engine-derived) on runs.
- `app_users.id` is its own UUID (not `auth.users.id` directly) with a separate `auth_id` column —
  rows are seeded directly by `0001_init.sql` step 10, no `auth.users` row required to exist first.
- `closed_by` is a UUID FK to `app_users.id` (not free text).

| # | Task | Status | File(s) |
|---|------|--------|---------|
| 5.1 | Schema migration: 6 tables, checks, indexes, RLS, `prune_expired()`, seed | ✅ | `supabase/migrations/0001_init.sql` |
| 5.2 | Link Supabase Auth → `app_users.auth_id` by email | ✅ | `supabase/migrations/0002_seed_app_users.sql` |
| 5.3 | `varianceSource()` helper | ✅ | `lib/engine/variance-source.ts` |
| 5.4 | `.env.example` / `.env.local` populated | ✅ | see below |
| 5.5 | Connector interface + orchestrator | ✅ all 4 connectors code-complete (DT, Odoo, Guard, Sheets) | `lib/connectors/*` |
| 5.6 | Validation schema | ✅ | `lib/validation/source-row.ts` |
| 5.7 | Persistence layer | ✅ | `lib/db/persist.ts` |
| 5.8 | Reconcile route (`CRON_SECRET`-guarded) | ✅ | `app/api/cron/reconcile/route.ts` |
| 5.9 | Verify: tsc + eslint + build + 24 tests green | ✅ | — |
| 5.10 | **Apply migrations + create Auth users** | ✅ **DONE** | applied via SQL Editor |

**Bugs found and fixed this pass (before the schema was ever applied):**
- `0001_init.sql` had a `UNIQUE INDEX ... WHERE status IN ('success','partial')` on
  `reconciliation_runs.business_date` — would have thrown a constraint violation the second
  time the pipeline ran for the same day. Changed to a plain (non-unique) index.
- `0002_seed_app_users.sql` joined against `auth.users` with uppercase `'ADMIN'/'MANAGER'` role
  values — would have violated the (lowercase) role CHECK constraint the moment it matched a
  row. Rewritten as an idempotent `UPDATE ... auth_id` linker matching the real schema.
- `lib/supabase/client.ts` was rewritten to export `getSupabaseClient()` but two call sites
  (`login-form.tsx`, `sidebar.tsx`) still imported the old `createClient` name — fixed both.

### `.env.local` status — fully populated
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (publishable), and
`SUPABASE_SERVICE_ROLE_KEY` (secret) are all set. `DT_MONGODB_URI` and `CRON_SECRET` are set too.

### Verification (2026-07-14) — all passed
- All 6 tables respond `HTTP 200` via REST (`app_users`, `reconciliation_runs`, `variances`,
  `source_rows`, `ingestion_logs`, `guard_uploads`).
- `app_users` has all 6 seeded rows with correct `role`/`city`, **and all 6 have a linked
  `auth_id`** — Supabase Auth users were created and `0002` successfully linked them.
- `prune_expired()` RPC callable (`HTTP 204`).

⚠️ Side effect now in force: the app has switched from demo-cookie auth to **real Supabase Auth**
on next dev-server restart. Log in with the same 6 emails/passwords — they now go through
Supabase for real, with RLS enforcing city-scoping for managers.

## ✅ Phase 6 — API Routes (code complete; now testable against the live DB, not yet tested)
All 5 routes from the plan's §E, all RLS-scoped via the cookie-bound server client (not the
admin client) so a manager only ever sees their own city:
- `GET /api/variances` — filtered/paginated list (city, date range, bucket, source, priority,
  status, direction).
- `PATCH /api/variances/[id]` — close / dispute / reopen (`dispute` → `in_progress`).
- `GET /api/runs` — recent reconciliation runs.
- `GET /api/stats/summary` — per-city + overall KPI aggregates, computed from `variances` (not
  from `reconciliation_runs.combined`, which is global and would leak cross-city data to a
  manager); falls back to the latest run if none exists for the requested date.
- `GET /api/sources` — raw `source_rows` drilldown for a given `run_id`.
- New helper: `lib/db/current-user.ts` (`getCurrentAppUser()`).

Now unblocked — tables + Auth users exist. Not yet exercised end-to-end with a real logged-in
session (needs a browser flow or a Playwright/curl-with-cookie test).

## 🟡 Phase 7 — Connectors Go Live (superseded by `DB MODEL.md` — code written, untested against real data)

**Correction to earlier notes:** the "`forms` collection, no barcode field" finding from earlier this
session was based on the wrong collection. `DB MODEL.md` (supplied 2026-07-14) gives the real
production schema for both DT and Odoo, with full field maps, direction-derivation rules, city
normalization tables, and exact queries (Mongo aggregation for DT, SQL for Odoo). Re-verified
directly against the live Mongo cluster:

- ✅ `orderfromcityfurnishes` (327,516 docs) **does** have `barcode` — **barcode blocker resolved.**
- ✅ **DT is now LIVE (2026-07-15).** The `tasks`-empty problem is solved: `tasks` really is empty
  (0 docs), but it was superseded by the **`deliveries`** collection (174,513 docs) — the doc's
  §18 schema was written against the old name. Proved it directly rather than guessing: enumerated
  all 25 collections on the cluster, then confirmed `orderfromcityfurnishes.pickup_deliveryId`/
  `deliveryId` resolve into `deliveries` (3/3), not tasks/trips/forms/etc., and that `deliveries`
  carries every field §18 expects on `tasks` (`scheduledDate`, `email`, `firstName`/`lastName`,
  `jobType`, `ticketNumber`, `city`, `category`, `subCategory`, `status`). `deliveries` has current
  data (through 2026 and beyond). The connector's source collection is now `deliveries`
  (configurable via `DT_TASKS_COLLECTION`). **No corrected connection string was needed — the
  existing `DT_MONGODB_URI` was fine all along; only the collection name was stale.**
- Also fixed while live-testing: DT date fields (`date`/`movementDate`/`createdOn`) come back as
  BSON `Date` objects; `String(date)` was producing an ugly locale string
  (`"Wed Jul 15 2026 …GMT+0530…"`) headed for the `variances.date` column — added a `dateStr()`
  helper that emits clean ISO. (Latent all along, but never surfaced while `tasks` returned 0 rows.)

| # | Task | Status | File(s) |
|---|------|--------|---------|
| 7.1 | DT connector — `deliveries`+`orderfromcityfurnishes` aggregation (§18), direction derivation (§14, 6-rule switch), done-only filter (§15), city map (§20) | ✅ **code done + live-verified: 357 rows for D-1 across all 5 cities, both directions** | `lib/connectors/dt.ts`, `dt-mapping.ts` |
| 7.2 | Shared IST-day→UTC window helper (§4/§17) | ✅ | `lib/connectors/ist-window.ts` |
| 7.3 | Metabase REST client (API-key or session auth, native SQL) | ✅ **live-verified** (username/password session against db 5) | `lib/connectors/metabase.ts` |
| 7.4 | **Odoo connector — Metabase native SQL against `stock_move_line`** (denormalized `movement_type`→direction, `procurement_status`→jobType, JSONB product extraction, `sale_order` join for SO number), city map (§8) | ✅ **code done + live-verified: 445 rows for D-1 across all 5 cities, both directions** | `lib/connectors/odoo.ts`, `odoo-mapping.ts` |
| 7.5 | ~~Get a working `DT_MONGODB_URI`~~ — **resolved 2026-07-15**: existing URI was fine; parent collection was `deliveries`, not the empty `tasks` | ✅ | `lib/connectors/dt.ts` |
| 7.6 | ~~Get Metabase credentials + Odoo database id~~ — **resolved 2026-07-15**: username/password provided, "Odoo Live Database" = db id **5** (auto-discovered via GET /api/database) | ✅ | `.env.local` |
| 7.7 | **Google Sheets — service-account read → `SourceRow`** (Sheets API v4, per-tab Outward/Inward direction, header-name column mapping, blank-template-row-safe 200-row buffer, Sheets-serial + text date parsing) | ✅ **code done + live-verified against real data** | `lib/connectors/sheets.ts`, `sheets-mapping.ts` |
| 7.8 | **Guard OCR — full pipeline built** (Azure Vision v3.2 async Read, Storage signed upload, per-page table reconstruction + direction detection, mandatory human review UI, `guard.ts` wired to read confirmed rows) | ✅ code done, ✅ Azure + migration 0003 both confirmed live — 🔒 only a real sample PDF left | see "Phase 7b" below |

### Phase 7f — Reconciliation-logic overhaul, validated on real data (2026-07-15) — ✅

Brainstormed the reco logic "like a warehouse manager" against **real 2026-07-12 data**
(DT 607 + Odoo + Sheets rows, no guard) and the ops team's actual WhatsApp chase lists.
The engine as-specced produced **727 false HIGH variances for one day** (ops manually chase
~10-15). Root causes found by measurement, all fixed:

1. **Odoo `sml.date` is the POSTING timestamp, not the movement date.** Measured: 237/607 DT
   movements posted same-day, 302 next-day, 0 the day before. The old same-day-only pull missed
   half of Odoo (39% DT↔Odoo overlap → 89% with a ±1-day posting window). Also the §4 per-city
   window keyed on `create_date` — which is ORDER creation (0→14+ days before movement) — was
   silently decimating Odoo coverage. Connector now pulls postings [R-1..R+1] and emits
   `createdOn` = IST posting date; `odoo-window.ts` rewritten to a uniform ±1-day posting window.
   Attribution safety: adjacent-day postings only ever MATCH (suppress false "Not in Odoo") —
   the "Odoo-Only" rung requires a same-day posting (`BarcodeView.odooSameDay`), so each posting
   is judged exactly once, in its own day's run.
2. **Reported-source gating** (`ReportedSources`, threaded `pullAll → runAllCities → classify`):
   a rung blaming a source's ABSENCE only fires when that source reported (connector OK, ≥1 row
   for the city). Outage/unfilled-sheet now reads as "source down", not hundreds of false HIGHs
   (MUMBAI: 129 false HIGHs → 4 real; HYDRABAD: 88 → 0). In the no-guard mode (the normal
   nightly case), Sheet+DT-agree-Odoo-missing **escalates from INFO to REAL "Not in Odoo"** —
   exactly the ops team's main manual chase item ("Odoo out missing" on WhatsApp).
3. **jobType now sourced DT > Guard > Sheet > Odoo** (`views.ts` rank map). DT's values
   ("Repair"/"Replace"/"New - Rental") normalize natively to the engine's REPAIR/REPLACE/
   NEW_RENTAL; Odoo's `procurement_status` (ok/new) never matched, so the repair/replace
   suppressions and direction-conflict skips were dead code on live data. Sheets/Guard now also
   map their Operation Type column.
4. **"Odoo-Only Entry" demoted REAL → INFO** (bucket layer, `original_priority` preserved):
   measured 462/day, 98% ordinary ON-RET customer orders = Odoo batch-posting earlier days'
   movements. Ops never chase these; a phantom posting is a periodic-audit item, not morning noise.
5. **Failed-delivery rule** (new REAL "Failed Delivery — Return Not Logged"): an OUT entry whose
   every status is not_done ("Not Delivered" — Sheets' Physical Status column is now mapped) is
   exempt from the normal ladder (a failed delivery is *rightly* absent from Odoo/DT-done), but
   its return leg must exist on the IN side — missing → chase item. Straight from ops practice
   ("…missing in Reg inward pls check and write them in Reg inward").
6. **PP boxes count-only** (new INFO "PP Box Movement (Count Only)"): free-text box entries
   ("PP BOX - 29") no longer run the ladder as fake barcodes — one count row per direction.
7. **Sheets buffer 200 → 1500 rows**: 200 only covered ~1 day of the busiest tab; a backfill
   pull of an older date silently lost most rows (BAN: 20 of ~200 found → false flood).
8. Vendor rows: PO Number now stands in for the blank SO (Sheets + Guard connectors).
9. Also measured & cleared: canonicalize() OCR-fold collisions on digital sources = **0** across
   1,656 real rows (fold is safe); cross-source direction disagreement = 8/384 multi-source
   barcodes (~2%, all DT:OUT-vs-Odoo:IN appliance replacements — small, surfaces as legit noise).

**Result on real 2026-07-12 (no guard): 727 false HIGHs → 85 REAL** (DELHI 64 — of which 59 are
a genuine GUR Odoo-posting backlog — MUM 4, PUNE 6, BAN 11, HYD 0) + 353 INFO audit rows.
Tests: 24 → 33, all green. The 4-source (guard-reported) ladder behavior is unchanged.

### Phase 7e — Cross-source normalization audit (this session) — ✅

Checked that all 4 connectors normalize into the shared `SourceRow` shape identically:

| Field | DT | Odoo | Sheets | Guard | Verdict |
|---|---|---|---|---|---|
| **city** | `normalizeCity` (name) | `normalizeOdooWarehouse` (code) | `normalizeCity` (config key) | stored `City` | ✅ different inputs → same `City` union |
| **direction** | §14 6-rule switch | `movement_type` | per-tab Outward/Inward | per-row (review) | ✅ all emit `IN`/`OUT`, skip if unresolved |
| **status** | `"done"` | `"done"` | `"done"` | `"done"` | ✅ |
| **barcode** | — | — | — | — | ✅ engine `canonicalize()` (upper + strip ws + OCR-fold) normalizes the join key uniformly; connectors now also all trim |
| **date** | was raw UTC ISO ts | was raw UTC ISO ts | IST `YYYY-MM-DD` | IST `YYYY-MM-DD` | ⚠️ **was inconsistent → fixed** |

**The one real discrepancy — the `date` field — fixed:** DT and Odoo were emitting full UTC ISO
timestamps while Sheets/Guard emitted IST `YYYY-MM-DD`. Worse, DT sourced `date` from
`items.updatedAt` (the barcode-scan completion time, which can land on the *next* calendar day),
so a 2026-07-14 run produced DT `date`s spanning 07-12/07-14/07-15. That feeds
`deriveRunDate()` (which only reads PHYSICAL+DT `date`) and risked the engine picking the wrong
business day → variances filed under a date the dashboard doesn't query.
Fix: every connector now sets `date = runDate` (the IST business date it was windowed on — the
correct semantic; the precise completion timestamp is preserved separately in `movementDate`).
Live-verified: DT 369 rows + Odoo 445 rows for a 2026-07-14 pull, all `date == "2026-07-14"`.
Also unified field trimming (DT/Odoo `str()` now trims like Sheets/Guard).

### Phase 7c — Google Sheets connector (this session) — ✅ code complete, ✅ **live-verified against real data**

- **Auth:** Google service account (server-to-server, no user consent flow) — `GOOGLE_SERVICE_ACCOUNT_KEY`
  holds the downloaded JSON key. The sheet must separately be shared with that key's
  `client_email` (Viewer) — a service account has zero access until a sheet is shared with it,
  same as adding any other collaborator. This was confirmed as the right shape with the user (as
  opposed to an OAuth client id/secret + human consent flow, unnecessary complexity for an
  unattended nightly cron job). **Real key inserted and confirmed working 2026-07-15**
  (service account `guard-sheet-reader@…`, in `.env.local` only — gitignored).
  ⚠️ Must be pasted as **one line** in `.env.local` — a raw multi-line JSON blob breaks standard
  `.env` parsing (only `"{"` gets read as the value). Caught and fixed for the real key.
- **Config:** `SHEETS_CONFIG` — one JSON env var, all 5 real spreadsheet ids now live:
  `{"DELHI":{"spreadsheetId":"1KVN_..."},"PUNE":{...},"MUMBAI":{...},"BANGALORE":{...},"HYDRABAD":{...}}`
  (city codes the user gave — GUR/PUN/MUM/BAN/HYD — mapped to the engine's full City names).
- **Real layout discovered live (differs from the original IMPLEMENTATION_PLAN.md §A3 guess):**
  each city's spreadsheet has separate **"Outward" and "Inward" tabs**, not one tab with an "Ops
  Type" column driving direction. Direction is now derived from **which tab** a row came from
  (Outward→OUT, Inward→IN) — the "Operations Type"/"Ops Type" column that does exist holds
  job-type-like text (Delivery, Pick Up, New - Rental, Upgrade), not IN/OUT, and the engine only
  reads `jobType` from ODOO rows anyway (`views.ts:76`), so it isn't mapped. Tab names default to
  `"Outward"`/`"Inward"` (confirmed identical across all 5 cities) with optional per-city override
  (`outwardSheet`/`inwardSheet`) in case a tab is ever renamed.
- **Header row isn't row 1** — every tab has a single-cell title row above it ("OUTWARD"/"Inward ",
  casing/whitespace varies) — `findHeaderRowIndex()` scans the first few rows for one containing a
  "date" cell instead of assuming a fixed offset.
- **Real bug caught + fixed via live testing: blank template rows.** Every sheet has thousands of
  blank rows appended after the real data (leftover formatting/dropdown validation keeps the
  Sheets API from treating them as empty) — e.g. DELHI/Outward reports 3,188 "data rows" but the
  real data ends around row 2,824; the rest is filler. A naive `slice(-200)` over the raw fetched
  rows grabbed blank filler instead of the last 200 real entries. Fixed: rows are filtered to
  "has a non-empty date cell" **before** the 200-row buffer is taken.
- **Column mapping is header-name-based, not position-based**, with real alias spellings seen live
  (e.g. "Barcode" on Inward tabs vs "Barcodes" on some Outward tabs) — `buildColumnIndex()`.
- **Date filtering:** `parseSheetDate()` (`sheets-mapping.ts`) handles both a Sheets serial-number
  date (confirmed live — dates come back as serials like `46174`) and manually-typed text dates
  (ISO, and DD/MM/YYYY read as day-first — India-based ops teams). Matched directly against the
  run's business date, no UTC conversion (sheet dates are plain IST calendar dates, same treatment
  as the Guard/PHYSICAL source).
- **Status:** always `"done"` — a row's presence on the sheet means it happened, matching
  IMPLEMENTATION_PLAN.md §A3's rule.
- **Live verification (2026-07-15):** compiled `sheets.ts` in isolation and ran `sheetsConnector.pull()`
  against the real 5 sheets for several candidate dates. `pull("2026-07-14")` (D-1 from today)
  returned 137 real rows (PUNE 25 OUT + 44 IN, HYDRABAD 40 OUT + 28 IN); `pull("2026-07-13")`
  returned 491 rows across all 5 cities. DELHI/MUMBAI/BANGALORE had no rows yet for 2026-07-14 at
  test time — their sheets' most recent entries were 1-2 days further behind (2026-07-11/12/13),
  a real data-entry lag on the ops side, not a connector bug — worth knowing before assuming a
  city's numbers are wrong on a given day.
- **Bug caught + fixed in passing:** `/api/cron/reconcile`'s default run date (when no `?date=` is
  passed — the real-world case once a scheduler is wired up in Phase 9) was literally "today"
  (`todayISO()`). Reconciliation is a D-1 process (a business day is only complete, across all 4
  sources, after it's fully closed out overnight) — every connector's date-window logic is written
  against that assumption. Renamed to `defaultRunDate()` and fixed to return yesterday's date.

### Phase 7d — Odoo connector (this session) — ✅ code complete, ✅ **live-verified against real data + a real export**

- **Transport:** Metabase native SQL (`/api/dataset`) against the "**Odoo Live Database**" Postgres
  connection, **database id 5** (auto-discovered via `GET /api/database`; DT's Mongo is id 6).
  Auth: Metabase **username/password** session (`METABASE_USERNAME`/`METABASE_PASSWORD`), the
  method the user has. Login + query confirmed live.
- **Ground-truth reference:** the user supplied a real Odoo export (`BAN-system in out.xlsx` — the
  BAN warehouse's In/Out `stock_move_line` rows for 12–13 Jul, 110 IN + 128 OUT). The connector
  query was reverse-engineered and validated against it column-by-column.
- **Key finding — everything is denormalized onto `stock_move_line`**, so the doc's (§6) multi-join
  direction-derivation was unnecessary. The real fields:
  - `movement_type` → `"In"`/`"Out"`/`"In Transit"` — **direction is a direct column** (we keep
    In/Out, filter out "In Transit" + null).
  - `procurement_status` → `"ok"`/`"new"`/`"damaged"`/`"partially_damaged"`/`"incomplete"` — this
    is the export's "**Procurement Condition**" column → `jobType`. (The doc guessed `procure_method`,
    which actually holds `make_to_stock`/`make_to_order` — a red herring.)
  - `product_template.name` is **JSONB** (`{"en_US": "..."}`) — extracted with `->>'en_US'` (raw
    column would have stored the whole translation map as the product name — a real bug avoided).
  - `sale_order` join (`sml.sale_order_id`) → `so.name` = the `ON-RET-…` SO number; `sml.reference`
    (e.g. `BAN/IN/22557`) → `ticketId`.
- **Warehouse codes:** live DB has 8 (`BAN, GGN, GUR, HYD, JDH, MUM, NOI, PUN`); only 5 carry active
  movements and map to the 5 cities. Added `GGN`/`NOI` → DELHI (NCR) defensively; `JDH` (Jodhpur)
  intentionally unmapped → skipped (not a reco city). `odoo-mapping.ts`.
- **Live verification (2026-07-15):** compiled + ran `odooConnector.pull()`. `pull("2026-07-14")`
  (D-1) → **445 rows** across all 5 cities, both directions (BAN 97 IN/92 OUT, PUN 58/22, MUM
  35/58, HYD 8/24, DELHI 34/17); `pull("2026-07-13")` → 490 rows (BAN 102 IN/112 OUT — closely
  tracks the export's ~110/128 scale, the small delta being day-boundary bucketing: the export is
  a naive 2-day manual pull, the connector uses precise IST windows).
- **Open (unchanged, DB MODEL.md §10):** `procurement_status` values (ok/new/damaged/…) still don't
  map to the engine's `REPAIR`/`REPLACE`/`NEW_RENTAL` jobType vocabulary. Passed through verbatim
  for now — needs a business decision on the mapping, but doesn't block barcode-first reconciliation.

### Phase 7b — Guard Register OCR pipeline (this session, code complete)

Full design in the approved plan (`.claude/plans/...atomic-toucan.md`) — summary:

- **Input:** one PDF per upload, handwritten register, **both IN and OUT pages in the same
  file** (direction varies per page, not per upload) — this ruled out Azure's newer synchronous
  Vision API (images-only) in favor of the older **v3.2 async Read API**, the only variant that
  natively accepts multi-page PDF. Async also means submit-then-poll, not one blocking call —
  important since a multi-page OCR job can outlast a single serverless function's timeout.
- **Human review is mandatory, not optional:** plain OCR (not Document Intelligence) on
  handwriting is unreliable enough that auto-feeding it into the barcode-first engine would
  silently corrupt the PHYSICAL source. Every row — cell text AND each page's direction — must
  be confirmed/corrected by a person before `status` can reach `processed`.
- **Two real gaps caught by a design-review pass, fixed in `0003_guard_ocr_review.sql`:**
  `guard_uploads` had no UPDATE RLS policy at all (nothing could ever change its own status), and
  the `guard-registers` Storage bucket didn't exist anywhere in `0001_init.sql` (dropped in an
  earlier rewrite).
- **Upload bypasses our server entirely:** browser → Supabase Storage via a signed upload URL,
  specifically to dodge Vercel's ~4.5MB request-body ceiling (multi-page scanned PDFs are often
  larger than that).

| File | What it does |
|---|---|
| `supabase/migrations/0003_guard_ocr_review.sql` | Storage bucket + RLS, 5-state status enum, `parsed_rows`/`ocr_raw_snapshot`/`ocr_operation_id`/`reviewed_by`/`reviewed_at` columns, the missing UPDATE policy, `direction` made nullable |
| `lib/connectors/ocr/azure-vision.ts` | v3.2 async Read client: `submitReadJob()` / `checkReadJob()` |
| `lib/connectors/ocr/table-reconstruct.ts` | Per-page row/column reconstruction: adaptive Y-gap row clustering + header-row-anchored column assignment |
| `lib/connectors/ocr/direction-detect.ts` | Best-effort per-page IN/OUT guess from header keywords; `null` (forces reviewer choice) when ambiguous — never silently guessed |
| `app/api/uploads/guard/route.ts` | POST — create upload row + Storage signed upload URL |
| `app/api/uploads/guard/[id]/submit/route.ts` | POST — download from Storage, submit to Azure, `status='ocr_running'` |
| `app/api/uploads/guard/[id]/status/route.ts` | GET — polled by the client; on Azure success, reconstructs + saves `parsed_rows`, `status='needs_review'` |
| `app/api/uploads/guard/[id]/route.ts` | GET/PATCH — reviewer fetches/confirms; PATCH sets `status='processed'` |
| `app/(dashboard)/uploads/review-grid.tsx` | The review UI — per-page direction selector, per-cell edit, merge/split/add/delete row |
| `app/(dashboard)/uploads/uploads-client.tsx` | Rewritten: PDF-only upload, real pipeline wired end-to-end when `supabaseConfigured`; demo `.xlsx` simulation kept as the fallback otherwise |
| `lib/connectors/guard.ts` | Rewritten: reads `guard_uploads` where `status='processed'` for the run date, maps `parsed_rows` → `SourceRow[]` |

**Update 2026-07-15 — both remaining blockers resolved:**
- **Azure Vision credentials** — confirmed live earlier this session: real HTTP requests against
  the resource, a hand-crafted test PDF submitted and polled to `succeeded` on the v3.2 Read
  endpoint. Not a blocker.
- **Migration `0003_guard_ocr_review.sql`** — the user believed they'd applied it but wasn't sure.
  Verified directly against the live Supabase project (service-role client, read-only checks +
  one throwaway insert/delete probe) rather than asking them to re-check manually: the
  `guard-registers` Storage bucket exists, all 5 new `guard_uploads` columns are queryable, and
  the 5-state `status` check constraint accepts `'ocr_running'`. **Confirmed fully applied.**
- **Real register columns, confirmed by the user** (not a guess anymore): `Sr. No, Date, SO No,
  Ticket ID, Customer Name, PO No, Vendor, Product Name, Barcode, Vehicle No, Delivery Associate,
  Operation Type` — 11 columns total, only 7 of which are kept (Date, SO Number, Ticket ID,
  Product, PO Number, Barcode, Operation Type). `table-reconstruct.ts` was reworked to a
  `REGISTER_COLUMNS` (all 11, for header-anchored X-range alignment) / `GUARD_COLUMNS` (the 7
  kept, what's actually stored/reviewed) split — reconstructing as if the form only had 7 columns
  would have misaligned every column boundary once the OCR'd header returns more cells than that.
  "Operation Type" is job-type-like text (not IN/OUT) — same non-mapping treatment as the Sheets
  connector's "Ops Type" column; direction still comes from per-page header-keyword detection
  (`direction-detect.ts`), unchanged.

**Still open:** an actual real sample PDF hasn't been run through the pipeline yet — the column
*names* are now confirmed, but the OCR/handwriting-reconstruction quality on a real scan is still
unverified.

**Known gap kept out of scope this pass:** the doc lists several DT/Odoo fields worth keeping in
`source_rows.raw` for audit (agent name, vehicle number, tried-barcode, etc.) that the current
`SourceRow`/`CityTaggedRow` types don't carry. Skipped for now to stay focused on what the engine
actually consumes; would need a generic `extra?: Record<string,unknown>` bag threaded through
`persist.ts` if you want full raw-field capture later.

**Also flagged, partly clarified (DB MODEL.md §10):** the real Odoo "job type" field is
`stock_move_line.procurement_status` (NOT `procure_method`, which holds `make_to_stock`/
`make_to_order`). Its live values are `ok`/`new`/`damaged`/`partially_damaged`/`incomplete`. These
still don't match the engine's `REPAIR`/`REPLACE`/`NEW_RENTAL` vocabulary, so `jobType` is passed
through as-is and the Odoo-window/repair-suppression rules keyed to those exact strings won't fire
for Odoo rows until a business decision maps `procurement_status` → engine job types.

## ⬜ Phase 8 — Frontend Rewire
- ⬜ Swap `admin-dashboard.tsx` / `manager-dashboard.tsx` off `demo-store.tsx` sample data onto
  the Phase 6 API routes; new columns per the plan's §B (Date, City, Item Name, Barcode, Ticket
  ID, Source, Ops Type, SO Number + Variance/Priority/Status/Action).
- ⬜ `components/source-badge.tsx` (colour pill: Odoo purple / DT blue / Sheet green / Physical
  orange / Cross red).
- ⬜ `lib/session.ts` reads real role/city from `app_users` (drop the ADMIN-for-all stub).
- ⬜ Rewire Analytics / System Health / Leaderboard / Email Digest off sample data.

## ⬜ Phase 9 — Scheduling & Retention
- ⬜ Vercel Cron (or external scheduler) → `POST /api/cron/reconcile` with `CRON_SECRET`.
- ⬜ Enable pg_cron for the nightly `prune_expired()` schedule (currently only called as a
  backstop at the end of each reconcile run).
- ⬜ Email digest via Resend (`RESEND_API_KEY`, `DIGEST_RECIPIENTS`).

---

## 🔒 Blockers / inputs needed from the user
1. ~~A `DT_MONGODB_URI` with a populated `tasks` collection~~ — **resolved 2026-07-15.** The existing
   URI was correct; the parent collection is `deliveries`, not the empty `tasks`. DT is live
   (357 rows for D-1, all 5 cities). No longer a blocker.
2. ~~Metabase credentials + Odoo database id~~ — **resolved 2026-07-15.** Username/password provided;
   "Odoo Live Database" = db id **5**. Odoo connector is live (445 rows for D-1, all 5 cities). No
   longer a blocker. (Optional hardening: swap the personal login for a dedicated Metabase **API
   key** before go-live so the cron doesn't depend on one user's password.)
3. ~~`AZURE_VISION_ENDPOINT` + `AZURE_VISION_API_KEY`~~ — **done.** Real credentials confirmed live
   against the v3.2 Read surface (not the newer PDF-incompatible v4.0 API). No longer a blocker.
4. **A real sample guard-register PDF** — column *names* are now confirmed (`GUARD_COLUMNS`/
   `REGISTER_COLUMNS` updated to match, Phase 7b), but nobody has run an actual scan/photo through
   the OCR + reconstruction heuristic yet, so real-world accuracy on handwriting is still unknown.
5. ~~Google Sheets — real values in `.env.local`~~ — **done 2026-07-15.** Real service account key +
   all 5 spreadsheet ids are live and pull-tested (see Phase 7c). No longer a blocker.
6. **Map Odoo `procurement_status` → engine job types** — the real field is now known
   (`stock_move_line.procurement_status`, values ok/new/damaged/…); needs a business decision on how
   those map to `REPAIR`/`REPLACE`/`NEW_RENTAL` (affects `jobType` — see
   Phase 7 note above).
7. **Rotate the DT `atlasAdmin` password** (shared in plaintext during testing) before go-live.
8. **Rotate the Supabase DB password** (shared in plaintext during setup) —
   Project Settings → Database → Reset database password.

## Notes / decisions on record
- Retention: variances kept forever (closed hidden from dashboard, not deleted); raw
  `source_rows` pruned at 7 days; dashboard window = open/in_progress within 7 days.
- Engine runs in a Next.js Node route (it's TypeScript) — pg_cron alone can't execute it.
- New-format Supabase keys are drop-in compatible with existing env var names (only values change).
- **DT/Odoo field mapping is now fully specified** by `DB MODEL.md` (2026-07-14, rev 2) — collection/
  table names, every field, direction-derivation rules, city normalization tables, done-only
  filters, and exact queries. This supersedes the earlier "`forms` collection" exploration entirely.
  `lib/connectors/dt.ts` and `odoo.ts` were rewritten to match it exactly; only credentials (not
  code) are the remaining blocker for both.
- Odoo transport decision resolved *for now*: implemented via **Metabase native SQL** (not direct
  Postgres or JSON-RPC) since Metabase access was the credential actually available. Swapping
  transport later only touches `lib/connectors/odoo.ts`'s `pull()` body.
