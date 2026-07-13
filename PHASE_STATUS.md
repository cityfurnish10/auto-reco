# Project Phase Status — CityFurnish Auto-Reconciliation Platform

_Last updated: 2026-07-13_

A running record of what's **done** and what's **to be done**. The detailed backend design lives
in [DB_Plan.md](./DB_Plan.md).

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
| 5 | Supabase database + ingestion pipeline | ⬜ planned (not started) |
| 6 | Connectors go live (DT, Sheets, Odoo, Guard OCR) | ⬜ / 🔒 |
| 7 | Dashboard reads from Supabase + retention | ⬜ |
| 8 | Cron scheduling, System Health, Email digest | ⬜ |

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

## ⬜ Phase 5 — Supabase Database + Ingestion Pipeline (planned — see DB_Plan.md)

Build order (from DB_Plan.md §Suggested build order):

| # | Task | Status | File(s) |
|---|------|--------|---------|
| 5.1 | Schema migration: 6 tables, checks, indexes, RLS, storage bucket, `prune_expired()`, pg_cron, new-user trigger | ⬜ | `supabase/migrations/0001_init.sql` |
| 5.2 | Seed `app_users` (idempotent upsert for the 6 known accounts) | ⬜ | `supabase/migrations/0002_seed_app_users.sql` |
| 5.3 | `varianceSource()` helper (extract `SOURCE_OF` from analytics) | ⬜ | `lib/engine/variance-source.ts` |
| 5.4 | `.env.example` key-format mapping notes | ⬜ | `.env.example` |
| 5.5 | Connector interface + orchestrator (DT + Sheets live; Odoo + Guard stubbed) | ⬜ / 🔒 | `lib/connectors/*` |
| 5.6 | Validation schemas (raw → `SourceRow`) | ⬜ | `lib/validation/*` |
| 5.7 | Persistence layer (runs / variances upsert / source_rows / ingestion_logs) | ⬜ | `lib/db/*` (new) |
| 5.8 | Reconcile route (the pipeline, `CRON_SECRET`-guarded) | ⬜ | `app/api/cron/reconcile/route.ts` |
| 5.9 | Verify: apply migrations, curl the route, tsc + build green | ⬜ | — |

## ⬜ Phase 6 — Connectors Go Live
- ⬜ **DT** — map `cityfurnish` movement docs → `SourceRow` (needs collection/field discovery).
- ⬜ **Google Sheets** — service-account read → `SourceRow` (needs `GOOGLE_SERVICE_ACCOUNT_KEY`).
- 🔒 **Odoo** — transport (direct Postgres `pg` vs JSON-RPC) **deferred** ("decide later").
- 🔒 **Guard OCR** — image → Storage → OCR provider (Google Vision / Textract / Tesseract)
  **provider not yet chosen**.

## ⬜ Phase 7 — Dashboard on Supabase + Retention
- ⬜ Repoint admin/manager dashboards to read `variances` (OPEN/DISPUTED, last 7 days, RLS-scoped).
- ⬜ New variance columns: **Product · Barcode · Source · Ticket ID · Reason** (+ city/priority/status).
- ⬜ Close/Dispute via server actions (closed = archived, hidden from dashboard, kept forever).
- ⬜ Retention: prune `source_rows` older than 7 days; variances kept all-time.
- ⬜ `lib/session.ts` reads real role/city from `app_users` (drop the ADMIN-for-all stub).

## ⬜ Phase 8 — Scheduling & Peripheral Wiring
- ⬜ Vercel Cron (or external scheduler) → `POST /api/cron/reconcile` with `CRON_SECRET`.
- ⬜ System Health page reads `ingestion_logs` instead of sample data.
- ⬜ Email digest via Resend (`RESEND_API_KEY`, `DIGEST_RECIPIENTS`).

---

## 🔒 Blockers / inputs needed from the user
1. **Supabase secret key** (`sb_secret_...`) — only the publishable key was provided; server-side
   cron writes need it.
2. **Odoo access decision** — direct Postgres vs JSON-RPC (connector interface is ready either way).
3. **OCR provider choice** — Google Vision / AWS Textract / Tesseract (for the Guard connector).
4. **DT movement collection** — confirm which `cityfurnish` collection holds movement history +
   its field names (can be discovered directly via Mongo).
5. **Rotate the DT `atlasAdmin` password** (exposed in chat) before production.

## Notes / decisions on record
- Retention: variances kept forever (closed hidden from dashboard); raw `source_rows` pruned at 7 days;
  dashboard window = OPEN/DISPUTED within 7 days.
- Engine runs in a Next.js Node route (it's TypeScript) — pg_cron alone can't execute it.
- New-format Supabase keys are drop-in compatible with existing env var names (only values change).
