# Project Phase Status — CityFurnish Auto-Reconciliation Platform

_Last updated: 2026-07-15 (Google Sheets connector built + live-verified against real data)_

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
| 7 | Connectors (DT + Odoo + Guard OCR code-complete; **Sheets code-complete + live-verified**) | 🟡 Sheets live; DT/Odoo/Guard still 🔒 on credentials |
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

- ✅ `orderfromcityfurnishes` (327,198 docs) **does** have `barcode`, populated on 308,120 of them
  (`FUMYEL18090363` etc.) — **the barcode blocker is resolved.**
- ❌ `tasks` (the collection joined for `city`/`scheduledDate`/`jobType`/direction context) is
  **empty** (0 docs, exact count) on the `DT_MONGODB_URI` currently in `.env.local`. Only one
  application database exists on that cluster (`cityfurnish`; checked `admin`/`config`/`local`
  too) — so this isn't a wrong-db-name issue. Most likely explanation: this connection string
  points at a different environment (backup/stale replica?) than whatever backs Metabase's
  "Delivery Tracker MongoDB" connection (DB id 6), which the doc's own reference cards (317, 404,
  564) prove has live joined data. **Needs a corrected `DT_MONGODB_URI`** — someone with Atlas
  console access should confirm which cluster/project Metabase's DB id 6 actually points to.

| # | Task | Status | File(s) |
|---|------|--------|---------|
| 7.1 | DT connector rewritten to the real `tasks`+`orderfromcityfurnishes` aggregation (§18), direction derivation (§14, 6-rule switch), done-only filter (§15), city map (§20) | ✅ code done, pipeline syntax-verified live | `lib/connectors/dt.ts`, `dt-mapping.ts` |
| 7.2 | Shared IST-day→UTC window helper (§4/§17) | ✅ | `lib/connectors/ist-window.ts` |
| 7.3 | Metabase REST client (API-key or session auth, native SQL) | ✅ | `lib/connectors/metabase.ts` |
| 7.4 | Odoo connector rewritten to Metabase native SQL (§6), city map (§8) | ✅ code done, untested (no Metabase creds yet) | `lib/connectors/odoo.ts`, `odoo-mapping.ts` |
| 7.5 | **Get a working `DT_MONGODB_URI`** (one with a populated `tasks`) | ⬜ 🔒 | — |
| 7.6 | **Get Metabase credentials** (API key, or username+password) + the Odoo database id in Metabase | ⬜ 🔒 | — |
| 7.7 | **Google Sheets — service-account read → `SourceRow`** (Sheets API v4, per-tab Outward/Inward direction, header-name column mapping, blank-template-row-safe 200-row buffer, Sheets-serial + text date parsing) | ✅ **code done + live-verified against real data** | `lib/connectors/sheets.ts`, `sheets-mapping.ts` |
| 7.8 | **Guard OCR — full pipeline built** (Azure Vision v3.2 async Read, Storage signed upload, per-page table reconstruction + direction detection, mandatory human review UI, `guard.ts` wired to read confirmed rows) | ✅ code done, ✅ Azure + migration 0003 both confirmed live — 🔒 only a real sample PDF left | see "Phase 7b" below |

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

**Also flagged, not resolved (DB MODEL.md's own open decision, §10):** Odoo's `procure_method`
values (`"Ok"`/`"New"`) don't match the engine's `REPAIR`/`REPLACE`/`NEW_RENTAL` vocabulary yet —
`jobType` is passed through as-is; the Odoo-window/repair-suppression engine rules that key off
those exact strings won't fire for Odoo rows until this is confirmed with an Odoo admin.

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
1. **A `DT_MONGODB_URI` that has a populated `tasks` collection** — current one connects fine but
   `tasks` is empty there (§ above). Someone with Atlas console access needs to confirm which
   cluster backs Metabase's "Delivery Tracker MongoDB" (DB id 6) and give that connection string.
2. **Metabase credentials** — an API key (preferred, Admin → API Keys) or username+password, plus
   the numeric database id for "Odoo Live Database" in Metabase (DT's is confirmed `6`; Odoo's
   isn't given — `GET /api/database` will list it once authenticated).
3. ~~`AZURE_VISION_ENDPOINT` + `AZURE_VISION_API_KEY`~~ — **done.** Real credentials confirmed live
   against the v3.2 Read surface (not the newer PDF-incompatible v4.0 API). No longer a blocker.
4. **A real sample guard-register PDF** — column *names* are now confirmed (`GUARD_COLUMNS`/
   `REGISTER_COLUMNS` updated to match, Phase 7b), but nobody has run an actual scan/photo through
   the OCR + reconstruction heuristic yet, so real-world accuracy on handwriting is still unknown.
5. ~~Google Sheets — real values in `.env.local`~~ — **done 2026-07-15.** Real service account key +
   all 5 spreadsheet ids are live and pull-tested (see Phase 7c). No longer a blocker.
6. **Confirm Odoo's `procure_method` values** with an Odoo admin (affects `jobType` mapping — see
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
