# Auto-Reco — Backend Engineering Notes

**Cityfurnish warehouse stock reconciliation.** Written for an engineer picking this
up cold. Verified against the codebase and live data on **27 August 2026**.

> **Using this with Claude:** drop this file into the conversation alongside the repo
> (`github.com/cityfurnish10/auto-reco`). It gives you the domain model, the
> invariants, and the measured facts that are *not* recoverable from reading the
> code — which is most of what makes this system tricky. Where this file and the
> code disagree, the code wins and this file is stale.

---

## 1. The problem, precisely

Five warehouses (Delhi/Gurugram serving NCR, Mumbai, Pune, Hyderabad, Bangalore).
Four independent systems each record stock movements. They disagree. Nobody could
say which was wrong, or whether a unit was actually missing.

The system pulls all four every night, matches **per canonical barcode, per
direction (IN/OUT)**, and emits a chase list. It is a *record comparison* engine,
not a stock count — output is never "short 14 units", it is "this unit is in
these books and not those, and here is who owns the fix".

### Two asymmetries that drive the entire design

**1. Only one source carries an outcome.** The ops sheet's Physical Status is the
only field that says whether a movement *completed*. `DT`, `ODOO` and `PHYSICAL`
hard-code `status: "done"` because each filters to completed rows upstream —
their "done" means *a record exists*, not *the movement succeeded*. A gate-register
"done" means the unit crossed the threshold, nothing more.

Consequence: a failed delivery is `sheet=Not Delivered` + silence from the other
three. That silence is **correct**. Getting this wrong classified 49 gate-confirmed
failed deliveries as REAL losses while the units sat in the warehouse.

**2. Only two sources carry a clock.** Odoo (`stock_move_line.date`) and DT
(`items.updatedAt`) have real timestamps. The gate register and ops sheet carry a
**hand-typed date with no time**. So only two can honour the 15:00 boundary; the
other two are matched on the typed date and covered by a process rule.

---

## 2. The business day

**15:00 → 15:00 IST.** Business date `D` covers `D 15:00` through `D+1 15:00`.
Not arbitrary — that is when the gate register is physically ruled off.

`lib/connectors/ist-window.ts` holds **two** day definitions and mixing them
corrupts data silently:

| Function | Meaning | Use for |
|---|---|---|
| `utcToIstDate` / `istDayToUtcWindow` | Calendar day, midnight→midnight | Things that really are calendar days |
| `utcToBusinessDate` / `businessDay*` | Business day, 15:00→15:00 IST | **Movement attribution** |

The engine decides REAL vs INFO by comparing an Odoo posting's date to the run
date. Re-base a connector's *pull window* without also changing its *attribution*
and you reclassify every posting made after 15:00 — with no error anywhere.

### Cadence

`REPORTING_LAG_DAYS = 1` (`lib/reconcile/cron-dates.ts`). Derive every offset from
that constant, never from a comment.

```
20:00 IST on D+2  →  /api/cron/reconcile   reconciles business date D
21:00 IST on D+2  →  /api/cron/email-digest  emails D
```

The lag exists because Odoo postings routinely land a day late; holding a day back
stops us raising alarms about entries that were about to arrive.

`vercel.json` is UTC and cannot carry comments (strict JSON, unknown keys
rejected — an `_comment` key once broke a deploy while every local check passed):

```
"30 14 * * *"  = 14:30 UTC = 20:00 IST   /api/cron/reconcile
"30 15 * * *"  = 15:30 UTC = 21:00 IST   /api/cron/email-digest
```

**Why 20:00 and not 16:30:** measured. Only 8 of 38 guard registers had ever
arrived by 16:30; 15 had by 20:00. Moving the run was cheaper than changing five
warehouses' behaviour.

**Vercel Hobby caps the project at 2 crons**, and both are used. Everything else
rides one of these two or runs from Postgres (`pg_cron`, see §6).

---

## 3. Architecture

```
                     ┌── Google Sheets  (ops movement register, per city)
 /api/cron/reconcile ├── Metabase → Odoo (native SQL over stock_move_line)
   (20:00 IST)       ├── MongoDB        (Delivery Tracker `deliveries`)
                     └── Supabase Storage (guard PDF) → Azure Doc Intelligence OCR
                                    │
                                    ▼
                    lib/reconcile/pipeline.ts  (the nightly sequence)
                                    │
                                    ▼
                    lib/engine/run.ts  → runAllCities → per-city results
                                    │
                                    ▼
      Supabase Postgres: source_rows · variances · movement_events ·
      run_city_stats · run_city_snapshots · ingestion_logs · reconciliation_runs
                                    │
        ┌───────────────────────────┼──────────────────────────┐
        ▼                           ▼                          ▼
   Dashboards (RLS)          Digest + follow-up          Gate app (/scan)
   admin + city manager      email (Gmail SMTP)          offline-first PWA
```

**Stack:** Next.js 16 (App Router, React 19, TS strict) · Tailwind v4 · Supabase
(Postgres + RLS + Auth + Storage) · Vercel `bom1`, Hobby tier, `maxDuration = 60`
· nodemailer over Gmail SMTP · `pdf-lib` · Vitest (62 files, 789 tests).
`resend` is installed but unused.

**Two Supabase clients, and the distinction is the security boundary:**

- `lib/supabase/server.ts` — cookie-bound, RLS-scoped. **Every user-facing read.**
- `lib/supabase/admin.ts` — service role, bypasses RLS entirely. Role lookup and
  cron jobs only.

---

## 4. The reconciliation engine

`lib/engine/` — barcode-level, per-direction. Read `run.ts` first; it is the
orchestrator and the only file that knows the whole sequence.

### Pipeline

```
OCR pending registers
  → pullAll()                     4 connectors, split per city
  → drop PP boxes / spares / invalid barcodes
  → build BarcodeView             per canonical barcode per direction
  → computeSuppressions()         removes views before classification
  → failed-delivery rule
  → classify()                    the ladder, 14 rungs, first match wins
  → applyBucket()                 REAL / INFO via VARIANCE_META
  → direction-conflict            same unit IN and OUT → CROSS
  → persist → per-city stats → prune
```

### File map

| Path | Role |
|---|---|
| `run.ts` | Orchestrator. Spare/PP split, view building, failed-delivery rule, bulk-SO collapse. ~1000 lines, the densest file |
| `ladder.ts` | The 14 classification rungs |
| `buckets.ts` | `VARIANCE_META` — REAL/INFO, owner, human note |
| `variance-names.ts` | The canonical strings. **Adding one needs 3 files in lockstep** + a digest label |
| `suppressions.ts` | Rules that remove a view *before* classification |
| `views.ts` | `BarcodeView`, `hasDone`, `sheetSaysNotDone`, `postedDone`, `displayBarcode` |
| `barcode.ts` | Canonicalization, validity, spare/PP detection |
| `direction-conflict.ts` | IN+OUT same unit same day → CROSS |
| `types.ts` | Read the doc comments here — they encode a lot of intent |

### Canonicalization

Uppercase, strip whitespace, then OCR-fold `O→0 I→1 S→5 Z→2 G→6`.

The fold can produce a string **no source system actually holds**. So there are
two barcode fields on every row: `barcode` (canonical — half the dedup key, never
show it to a human) and `barcode_display` (what a typed source actually wrote —
what a human can paste into Odoo). Migration 0020. Never join on `barcode_display`.

### The ladder

`lib/engine/ladder.ts`. Classifies on the presence pattern of `P/S/D/O`
(Physical / Sheet / DT / Odoo), first match wins, 14 rungs.

**The invariant that matters most: a source that did not report is never blamed.**
Every rung that blames a source for an absence gates on `rep.X` — that source
actually filed for this city+run. Without it, one Metabase outage renders as
hundreds of false HIGH variances and the tool loses credibility permanently.

A **zero count is not the same as not reporting**, which is why `run_city_stats`
stores both separately.

With the guard register unreported (common — uploads are async), the ladder runs
in a "3 typed sources" mode: guard-blaming rungs are skipped and Sheet+DT-agree-
Odoo-missing escalates from INFO to the REAL "not posted in Odoo" chase item,
which is exactly what ops hunt manually every morning.

### Bucketing

REAL vs INFO is a property of the variance **name**, looked up in `VARIANCE_META`.
11 REAL types, 12 INFO, 23 total. INFO rows get `priority` forced to `Info`,
`original_priority` preserved, `dampened: true`. Non-destructive — it only
re-tags for reporting.

### Suppressions

`computeSuppressions()` runs before classification and removes views entirely.
The operationally-normal cases:

- **DT All-Pending** — every DT row for the unit is `pending`/`not_done` → suppress everything, including duplicate-scan variances.
- **Failed-delivery return (IN)** — sheet received, no gate, DT pending both directions, no Odoo.
- **WH received-back undelivered (IN)**.
- **Inward DT quantity-aggregation (IN)** — a PO receipt of N identical units is sometimes logged in DT as one quantity rather than N barcodes. Sheet + Odoo confirm, DT absent. Suppressed *only* when the guard also has it or did not report; if the guard reported and is missing the unit, that is a genuine REAL and is left to fire.
- **Internal repair movement (OUT)**.
- **Silent OCR / SO-match** — the barcode is missing from the physical register, but the same SO or ticket appears under a *different* canonical in physical for the same product. Suppressed silently; must never surface anywhere.
- **Odoo nearby-day** — an Odoo-only posting for a unit a floor source documented on an adjacent day. The ±1 posting window pulls one Odoo row into three runs; on the neighbouring days it would file a variance against a movement already reconciled on its own day.

### Things that never become variances

Spares, consumables and PP boxes are **counted, not matched** — they exist in the
register, sheet and DT but never in Odoo, so matching them would show them
permanently missing.

Detection uses barcode shape, ops type, item name and the remarks column.
Item name `"Not Found"` is a strong spare signal — the floor types a description
into the barcode column (`WP water seal - 13`) and the product lookup resolves
nothing; **366 sheet rows** carried it.

**The safeguard the data forced:** of 219 such rows with a plausible barcode, 217
appeared in no other system and were genuine spares — but **2 were real Odoo lot
serials** whose sheet line simply had a blank product column. Reclassifying those
would have erased a real PO receipt. So: *a barcode that DT, Odoo or the guard
register knows as a real tracked unit is never reclassified by sheet text.*

---

## 5. Connectors

`lib/connectors/`, all returning a common `SourceRow[]`.

| File | Source | Notes |
|---|---|---|
| `sheets.ts` | Google Sheets API, service account | Per-city "Movement Register", Outward/Inward tabs |
| `odoo.ts` | Metabase REST, native SQL over `stock_move_line` | Windowed ±1 day for posting lag |
| `dt.ts` | MongoDB `deliveries` | Windowed on `items.updatedAt` |
| `guard.ts` | OCR'd rows from `guard_uploads` | OCR itself in `ocr/document-intelligence.ts` + `ocr/process.ts` |
| `warehouse-calendar.ts` | MongoDB `master_datas` | Weekly-off + holidays, read live |

### Field quirks — all measured on live data

| Field | Reality |
|---|---|
| `DT.scheduledDate` | **6,659 of 6,753 pinned at exactly 10:00 IST** — a date marker, not a clock. Do not window on it |
| `DT.items.updatedAt` | Real completion time, evening peak 17:00–21:00. **Window on this** |
| `Odoo.sml.date` | *Posting* time, set at validation — not movement time. ~half post next day (302 of 607 on 2026-07-12) |
| `Odoo.procurement_status` | Becomes `jobType` but its values are `ok`/`new`/`damaged` — not an ops type |
| Sheet `product = "Not Found"` | Usually a spare (above) |
| Sheet dates | Delhi writes `7/13` (month-first), Hyderabad `13-07` (day-first) |

**Vendor PO receipts:** measured 2026-08-10, **every one of 162 "PO Inward" sheet
rows** had its Odoo receipt posted +2 or +3 days later — so the ±1 window can
never match one. That is why `ODOO_POSTED_LATE` exists as an INFO type; telling a
warehouse to "post this in Odoo" for an entry already made is the single most
common false alarm they report.

### The warehouse calendar

`lib/engine/schedule.ts` carries `WEEKLY_OFF_DAY` as a hardcoded literal
(Mumbai/Hyderabad/Pune = Thursday). `lib/connectors/warehouse-calendar.ts` reads
the same fact from DT's `master_datas` collection, where ops maintain it as
editable data — and verified live 2026-07-31 the two agree exactly for all five
cities. So the hardcoded map was right, and it can now stop being hardcoded: an
ops change reaches this system without a deploy.

The real prize was the **holiday table — 29 one-off closures** the reconciler had
never known about, including dates where a city was shut, every floor source
correctly went quiet, and we called it a missing register.

`status` on those records is the **active flag**, not a closure flag. A
`weekly_off` row with `status=false` is a rule switched off, not a day the
warehouse worked.

---

## 6. Scheduling, and what rides on what

Only two Vercel crons exist, so extra scheduled work is layered:

- **`/api/cron/reconcile`** also runs the **re-check sweep** (migration 0018), re-running D-2…D-7 so late-arriving registers and Odoo postings get folded in.
- **`/api/cron/email-digest`** also **drains the scheduled-email queue** (`lib/email/scheduled.ts`) and sends **follow-up emails** (`lib/email/followup/`).
- **`pg_cron` in Postgres** runs the rest — `gate-expected`, `gate-media`, `gate-day-end`, `settle-queue` — each a `SECURITY DEFINER` function that POSTs to the route with a Vault-held secret. Migrations 0028 / 0030.

Both cron routes are gated on a `CRON_SECRET` bearer token.

Vercel Hobby does not guarantee the 15-minute gap between the two, which is why
the digest reports an incomplete run in a banner rather than silently falling
back to the previous day. An email nobody receives is worse than one carrying a
warning.

### The settle sweep

`lib/reconcile/settle.ts`. Measured 2026-08-10: **17,895 open variance rows**, of
which 13,492 (75%) had a business_date older than the oldest retained
`source_rows`, so no re-run could ever look at them again; and 4,079 carried a
name the system itself labels tier-3 "nothing to do".

Nothing closed either group — `prune_expired` only deletes already-closed rows,
and `resolveStaleOpenVariances` only fires when a date is reconciled again, which
a pruned date never is. So the count could only grow. Hence a daily sweep with
two honest closure reasons, `AGED_OUT` ("the evidence is gone — unverifiable",
*not* "resolved") and `NO_ACTION`. `MIN_AGE_DAYS = 8`, deliberately past the
re-check window. It never touches a row a human has moved off `open`, and it does
nothing at all when `source_rows` is empty (a half-restored DB must not read as
"every date has expired").

---

## 7. Database

Supabase Postgres. Types mirror tables in `lib/db/schema.ts`; writes go through
`lib/db/persist.ts` using the service role. **RLS is enabled on all data tables.**

| Table | Purpose |
|---|---|
| `app_users` | Users, role (`admin`/`manager`/`viewer`/`guard`), assigned city, linked to Supabase Auth by `auth_id` |
| `reconciliation_runs` | One row per run — status, trigger, aggregate counts |
| `source_rows` | The raw pulled feed per run, all 4 sources |
| `variances` | Engine output. Natural key `(business_date, city, direction, barcode, variance_name)` |
| `movement_events` | Every movement seen, clean or not (0015) — the row `variances` cannot carry because it only records problems |
| `run_city_stats` | Per-city rollup, upsert on `(business_date, city)` — powers leaderboard, analytics, digest |
| `run_city_snapshots` | Per-run point-in-time state (0017), for run-vs-run diffing |
| `ingestion_logs` | One row per connector per run — System Health |
| `guard_uploads` | Register uploads + OCR state (`pending → ocr_running → needs_review → processed`) |
| `email_logs`, `scheduled_emails` | Digest audit + queue |
| `gate_*`, `guard_*` | The gate subsystem (§8) |

Storage bucket `guard-registers`, PDFs at `{CITY}/{business_date}/{id}.pdf`.

### RLS

`auth_is_admin()` and `auth_city()` are `SECURITY DEFINER` helpers (migration
0004 — they exist to break policy recursion). Policies read them:

```sql
for select using (public.auth_is_admin() or city = public.auth_city())
```

Any new page that lists variances gets city-scoping **for free** if it uses the
cookie-bound client. `createAdminClient()` leaks every city.

### `upsertVariances` — the contract worth knowing

Upserts on the natural key and **deliberately never overwrites human closures**.
`status`, `closed_at`, `closed_by` and `closure_reason` are omitted from the
upsert payload, so a re-run cannot undo somebody's decision. `last_seen_at` is
re-stamped. Superseded rows are hard-DELETEd with no tombstone — which is why
run-vs-run comparison reads `run_city_snapshots` rather than trying to reconstruct
a past run from `variances`.

### Migrations are applied by hand

0001 → 0035, run in the Supabase SQL editor. **There is no direct Postgres URL in
the environment**, so code must not assume a migration has been applied — ship
code that *degrades*:

- `saveCityStats` catches `42703` (undefined_column) and retries without the 0012 columns. Without that, an unapplied migration fails the whole nightly reconcile.
- `/api/variances` catches it for `priority_rank` and reports `sortDegraded` to the UI.

Ordering when schema and code change together: **defensive change first, then the
migration, then the code that depends on it.** Both naive orders can break the
nightly run.

---

## 8. The gate subsystem (migrations 0023–0035)

Replaces the handwritten register. Justification, from 0023: the gate log was the
**missing book for 79% of units**, and of the lines that were written, OCR
recovered only **483 of 738** on 31 Jul 2026.

A guard-facing PWA at `/scan` (`app/(gate)/scan/scan-app.tsx`) — one component
with screen state, not routed pages, because at a gate a route transition is a
blank frame and a lost camera stream.

### `lib/gate/sync.ts` — the whole design in one line

> The device owns its own identifiers; the server owns everything else.

A phone offline for four hours arrives with a trip, forty scans, a shift and
three face checks, in arbitrary order, possibly for the second time. All four
facts are survivable:

- **Replay** — every row carries a client id with a UNIQUE constraint, so a re-send is a no-op. Double-counting an OUT movement is worse than missing one: it invents stock leaving the building.
- **Order** — scans reference their trip by *client* id, and trips are applied first, so a batch is order-independent.
- **Partial** — one bad row must not reject the batch; each item gets its own verdict and the phone clears only what landed.
- **Authority** — the device proposes; the server decides business date, city, site, geofence and photo sampling. A phone is the least trustworthy thing in the system.

Rejections are persisted server-side (migration 0033) — they used to be returned
only to the phone, so the record of a refusal lived in one guard's browser storage
on a handset nobody else could open.

### The design constant to not "fix"

`lib/gate/config.ts`:

```ts
export const COMPLETENESS_SHOWN = false;   // and it is meant to stay false
export const EXPECTED_CHECK_LIVE = false;
```

**The guard is never shown what is expected.** The gate is worth building because
it is an *independent* witness — the one source where a human physically saw the
item cross the threshold. Show a guard the list and they scan against the list;
the record stops being what was seen and becomes a confirmation of what Odoo and
DT already believed. Four sources collapse into three, and the one meant to catch
the others agrees with them by construction.

The check still runs and is still recorded (`gate_trips.expected_*`); a manager
reads it after the fact in the portal. This has been re-litigated twice, which is
why the intent is written into a constant rather than merely absent.

Same logic drives `lib/gate/completeness.ts`: a trip's scope is **discovered from
the scans**, never picked from a list. Scan an item and its picking is in play; if
that picking has nine lines and three were scanned, six are missing. A picking
nobody scanned from is not this trip's business.

### Other gate specifics

- **Auth** (`lib/gate/auth.ts`) — device holds a long-lived token, stored SHA-256 hashed; the PIN never leaves the phone (salted, 50k iterations). Opening the app needs no network, and revoking a phone is one row rather than a session hunt.
- **Face check runs on the device.** Reference photo cached at enrolment, live selfie compared locally, only score + verdict uploaded. No face image reaches a third party — cleanest position under India's DPDP Act, and it works with no signal.
- **Geofence** 200m (tightened from a 400m guess in 0034). `geoOk()` returns **`null`, never `false`**, when there is no fix or no pinned site — absence of evidence recorded as absence, not as failure. A guard outside the circle is never refused, only flagged.
- **Fleet list** (`lib/gate/fleet.ts`) read from DT **through Metabase**, not Mongo — the credential already exists, nothing new is provisioned, and an aggregation pipeline cannot write. Fetched live, not scheduled: a truck swapped at 18:00 is the normal case. Degrades to a plain text box if DT is unreachable.
- **Photo sampling** 10% of clean outward scans (`OUTWARD_PHOTO_SAMPLE_RATE`). At ~740 units/day a forced photo adds ~5 min per truck and proves little; because the guard cannot predict which are drawn, the deterrent survives at a tenth of the cost.
- **Sites in the DB, not code** (0026) — hardcoded placeholder coordinates meant every scan recorded `geo_ok = false`. Geocoding the postal address doesn't fix it either: the address resolves to the centre of the village, over a kilometre away. A manager pins it standing at the gate.

---

## 9. Traps that have already caused live bugs

1. **PostgREST silently caps un-ranged selects at 1,000 rows.** Caused KPI cards to show "169 REAL" for a run holding 555. **Always paginate aggregate reads** — pattern in `app/api/stats/summary/route.ts`.
2. **`source_rows` retains every re-check pass for a date.** Filtering by `business_date` alone returns the same movement several times: **4,106 rows for a day the run pulled 896**. Scope to `run_id`.
3. **Window and attribution must move together** (§2).
4. **RLS is the authorisation, not app code** (§7).
5. **Migrations are applied by hand** — degrade on `42703` (§7).
6. **`vercel.json` has no local safety net.** `npm run build` never validates it; only `vercel build` does.
7. **Tailwind scans `lib/**`** — class strings there must be *literal*. Twelve uses of `bg-accent-soft` generated no CSS for months because the token was never declared in the config.
8. **`position: fixed` inside the sidebar** renders off-screen — the `<aside>` sets a `translate`, making it a containing block. Portal to `document.body`.

---

## 10. What changed in August 2026

Three commits on `main`, not yet pushed at time of writing.

### The failure-vs-emptiness bug

Screens rendered **"Everything is accounted for — No open losses for this run"**
beside a failed fetch. An empty state is a claim about the *data*; an error is a
claim about the *request*. On a product whose only job is to be trusted about
missing stock, conflating them is the most expensive thing it can print.

Root cause was in two layers:

- **Server:** a handler that threw escaped to the framework, which replies 500 with an **empty body**. The client then called `res.json()` on nothing and raised `Unexpected end of JSON input`, which is what the dashboard printed at warehouse staff. Note the shape: every client already had a `json.error ?? HTTP ${status}` fallback and **none of them could ever fire**, because reading the body is what threw.
- **Client:** `EmptyState` was chosen on `rows.length === 0` alone.

Fixes:

- `lib/api/json-route.ts` — `jsonRoute()` wraps a handler so there is a JSON body on every path. Applied to **65 handlers across 47 of the 48 route files**. `app/api/chat` is deliberately excluded: it already has try/catch/finally over its whole body and degrades to a user-facing fallback reply.
- `components/error-state.tsx` — promoted from a local `LoadError` in `gate-client.tsx`, which had been written after a real incident (a guard *was* saved, the list query failed, the screen said "No guards yet", and a duplicate guard was created).
- **`EmptyState` now takes a required `error` prop.** Optional is free to forget, and forgetting is exactly the failure mode — 11 call sites checked only length. Required means `tsc` stops at every construction site until it answers "empty, or failed?". Same trick as `VarianceRowOut.present` in `lib/engine/types.ts`.
- `statFigure()` in `lib/ui/stat-captions.ts` — a KPI renders an em dash, never a `0`, when unread. `agg?.real ?? 0` was printing a confident zero for a figure never fetched.
- A third instance found while wiring it: `day-recheck-panel.tsx` called `setUnits([])` in its catch, so a failed sub-fetch rendered "Nothing in this group". It also called `.json()` before checking `r.ok`.

### Known-broken, pre-existing

**`npm run build` fails** with `FATAL ERROR: JavaScript heap out of memory` in the
TypeScript phase (compilation itself succeeds). Confirmed pre-existing by
stash-testing the baseline. Likely cause is in the build's own warning: stray
`package.json` + `package-lock.json` in the developer's home directory make Next
infer `~` as the workspace root. Fix is `turbopack.root` in `next.config.ts`, or
delete the strays. `npx tsc --noEmit` alone passes in seconds.

---

## 11. Open items

| | |
|---|---|
| **Thursday weekly-off overlap** | Business day Thursday runs Thu 15:00 → **Fri 15:00**, so it contains Friday-morning working hours, but the engine treats the whole date as closed and suppresses same-day REALs. A likely weekly leak for Mumbai, Hyderabad, Pune. **Raised three times, unanswered.** Needs a business decision, not a code change |
| **Mumbai at 32.9% accuracy** | 338 `Ops Sheet Only`. Predates all recent work; largest single signal in the data |
| **`Medium` priority unreachable** | No row carries it. Either the ladder never emits it or the filter option is dead weight |
| **Ops-sheet free text in `job_type`** | `Replacement 4`, `Repless.`, `Delivery not done` appear as distinct ops types |
| **README + handover are stale** | README describes 8 migrations (there are 35) and 16:30 crons (they are 20:00); handover stops before the entire gate subsystem |

### Deliberately not done

- **Odoo/DT do not fetch non-complete rows.** The engine infers "in transit" from absence rather than seeing it. Changing that is a connector-level decision with an ingest-volume cost.
- **The register PDF is built from sheet rows, not exported from Google.** The export needs `drive.readonly` added in Cloud Console and renders the whole tab (~1,500 rows), not one date.

---

## 12. Working on this codebase

### Verifying an engine change

Unit tests are necessary and not sufficient. The only trustworthy method:

```
1. Write a harness: replay stored source_rows for a date range through
   runReconciliation, scoped to ONE run_id per day.
2. Run it → save output.
3. git stash the change → run again → save output.
4. git stash pop → diff.
```

Both sides share the harness, so its inaccuracies cancel and the delta is
attributable purely to the change. **Expect only the rows you predicted to move;
anything else is a regression.**

Two earlier attempts were invalid and both looked plausible: one produced
**+10,981 phantom duplicates** by replaying multi-run rows, the other passed
`reported`/`recentFloor` defaults the real run never uses.

### Habits this codebase expects

**Measure, don't assert.** Query the live DB before claiming behaviour. A
hypothesis that the biggest REAL category was failed deliveries turned out to be
**4 of 592 (1%)** — reporting that honestly was more useful than shipping it.

**Comment the *why*, never the *what*** — especially the constraint that stops the
next person "fixing" something deliberate. Much of what looks odd here is
load-bearing, and the comment is the only thing between you and a regression.

### Conventions

- `feat(scope):` · `fix(scope):` · `polish(scope):` · `docs(scope):`
- Body explains **why**, with measurements and rejected alternatives.
- Author is **Shantanu Bhadada** only. **No `Co-Authored-By` trailer.**
- Secret-scan the staged diff before every push. `.env*.local`, `*.xlsx/xls/csv/pdf` and `/reports/` are gitignored (customer PII).

### Before every push

```bash
npx tsc --noEmit && npm run lint && npm test && npm run build
```

(`npm run build` currently fails for the pre-existing reason in §10 — check it is
still *that* failure and not a new one.)

### Environment

`.env.local`, gitignored, 23 keys: Supabase (URL, anon, service role) · Google
service account + `SHEETS_CONFIG` · Metabase (URL, API key or user/pass,
`METABASE_ODOO_DB_ID`) · DT Mongo URI/db/collection · Azure Vision endpoint + key
· Gmail user + app password + `DIGEST_RECIPIENTS` · `GROQ_API_KEY` (the portal's
chat assistant) · `CRON_SECRET` · `NEXT_PUBLIC_APP_URL`.

Without Supabase configured the app falls into a **demo mode** — but be warned,
demo mode models an older version of the product (quantity deltas,
`HIGH/MEDIUM/LOW`, an `.xlsx` upload flow) and will teach you the wrong domain
model. It is stale, not a spec.
