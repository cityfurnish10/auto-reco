# Phase 1 — Supabase Schema & DB Layer

**Status:** Ready to deploy  
**Date:** 2026-07-14

---

## Files Created

| File | Purpose |
|------|---------|
| `supabase/migrations/0001_init.sql` | Full migration — 6 tables, indexes, RLS, prune function, seed data |
| `lib/supabase/admin.ts` | Service-role client (bypasses RLS, used by cron pipeline) |
| `lib/supabase/client.ts` | Browser-side anon client (respects RLS) |
| `lib/db/schema.ts` | TypeScript interfaces for all 6 DB tables |

## Files Modified

| File | Change |
|------|--------|
| `lib/db/persist.ts` | `source` → `variance_source` in upsert payload, added `date` field, fixed `createRun` to write `business_date`, added `completed_at` to `finalizeRun` |

## Tables

1. **app_users** — admin / manager / viewer with city assignment
2. **reconciliation_runs** — one row per pipeline execution, unique index on business_date for success/partial
3. **source_rows** — raw connector output (pruned at 7 days)
4. **variances** — engine output + human resolution, dedup key `(business_date, city, direction, barcode, variance_name)`
5. **ingestion_logs** — per-connector health per run
6. **guard_uploads** — OCR file upload tracking

## Critical Rules Preserved

- Upsert on variances NEVER overwrites: `status`, `closed_by`, `closed_at`, `closure_reason`, `closure_note`, `first_seen_at`
- RLS: admins see all, managers see their city only, service role bypasses everything
- Prune: source_rows 7d, closed variances 90d, failed runs 30d
- Seed data: 6 platform users (1 admin + 5 city managers)

## Alignment Verification

persist.ts payload columns have been cross-checked against migration columns:

- `createRun` → `reconciliation_runs` ✓
- `saveSourceRows` → `source_rows` ✓
- `upsertVariances` → `variances` ✓ (variance_source fixed, date added, completed_at added)
- `saveIngestionLogs` → `ingestion_logs` ✓
- `finalizeRun` → `reconciliation_runs` ✓
- `prune` → calls `prune_expired()` RPC ✓

## To Deploy

1. Paste `0001_init.sql` into Supabase SQL Editor, or:
2. Run `npx supabase db push` (requires Supabase CLI + project link)

## Env Vars Needed

```
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

## Next → Phase 2

DB layer API routes: `/api/variances` (GET + filters), `/api/variances/[id]` (PATCH close/dispute), `/api/runs`, `/api/stats/summary`.
