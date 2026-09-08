# Auto-Reco — working notes for Claude

Nightly warehouse stock reconciliation for Cityfurnish. Five cities (Delhi/Gurugram
serving NCR, Mumbai, Pune, Hyderabad, Bangalore). Four independent records of the
same movements are compared **per canonical barcode, per direction**, and the
disagreements become a chase list plus a nightly digest email.

It is a **record-comparison** engine, not a stock count. Output is never "short 14
units" — it is "this unit is in these books and not those, and here is who owns it".

Longer prose version: `handover/` (note: `README.md` and `handover/*` are stale in
places — they predate the gate subsystem and quote old cron times).

---

## Commands

```bash
npm run dev            # localhost:3000
npm test               # Vitest, 62 files / 789 tests
npm run lint
npx tsc --noEmit
npm run build          # CURRENTLY FAILS — see "Known broken" below
```

Before every push: `npx tsc --noEmit && npm run lint && npm test && npm run build`

Read-only production probes (safe, and the right way to answer "what is actually
true?" rather than recalling it):

```bash
node scripts/gate-status.mjs        # live state of the gate app
node scripts/db-readonly-check.mjs  # proves the read-only login works and cannot write
node scripts/smoke-gate-flow.mjs    # drives the guard app through a whole trip
```

---

## Invariants — breaking these corrupts data silently

**1. Two definitions of "day" coexist.** `lib/connectors/ist-window.ts`.
- `utcToIstDate` — calendar day. For things that really are calendar days.
- `utcToBusinessDate` — **business day, 15:00→15:00 IST**. For movement attribution.

The engine decides REAL vs INFO by comparing an Odoo posting's date to the run
date. Change a connector's *pull window* without changing its *attribution* and you
reclassify every posting made after 15:00, with no error anywhere.

**2. A source that did not report is never blamed for an absence.** Every ladder
rung that blames a source gates on `rep.X`. Without it, one Metabase outage renders
as hundreds of false HIGH variances. **A zero count is not the same as not
reporting** — `run_city_stats` stores both.

**3. Only the ops sheet carries an outcome.** DT, Odoo and the guard register
hard-code `status: "done"` because each filters to completed rows upstream. Their
"done" means *a record exists*, not *the movement succeeded*. A failed delivery is
`sheet = Not Delivered` + silence from the other three, and that silence is correct.

**4. RLS is the authorisation, not app code.** `lib/supabase/server.ts` (cookie-bound,
RLS-scoped) for every user-facing read. `lib/supabase/admin.ts` bypasses RLS
entirely — role lookup and cron only. Any new page listing variances gets
city-scoping for free *if* it uses the cookie client.

**5. An empty result and a failed read are different claims.** `EmptyState` takes a
**required** `error` prop for this reason (`components/empty-state.tsx`), and
`statFigure()` renders an em dash, never `0`, for an unread figure. Never let a
failed fetch render as "Everything is accounted for". Use
`components/error-state.tsx`.

**6. `barcode` vs `barcode_display`.** `barcode` is the canonical fold
(`O→0 I→1 S→5 Z→2 G→6`) and is half the dedup key — it can be a string no source
system holds, so never show it to a human. `barcode_display` is what a typed source
actually wrote. **Never join on `barcode_display`.**

**7. The guard is never shown what is expected.** `COMPLETENESS_SHOWN = false` and
`EXPECTED_CHECK_LIVE = false` in `lib/gate/config.ts` are meant to stay false. The
gate's whole value is being an *independent* witness; show a guard the list and the
record becomes a confirmation of what Odoo already believed. The check still runs
and is recorded for a manager to read afterwards. Re-litigated twice.

---

## Traps that have already caused live bugs

1. **PostgREST silently caps un-ranged selects at 1,000 rows.** Once showed "169 REAL" for a run holding 555. Always paginate aggregate reads — pattern in `app/api/stats/summary/route.ts`.
2. **`source_rows` retains every re-check pass for a date.** Filtering by `business_date` alone returned 4,106 rows for a day the run pulled 896. **Scope to `run_id`.**
3. **Migrations are applied by hand** and there is no direct Postgres URL. Ship code that degrades on `42703` (undefined_column) rather than failing the nightly run — see `saveCityStats`.
4. **`vercel.json` has no local safety net.** `npm run build` never validates it; only `vercel build` does. Strict JSON, unknown keys rejected, no comments — an `_comment` key once broke a deploy while every local check passed.
5. **Tailwind scans `lib/**`** — class strings there must be literal. Twelve uses of `bg-accent-soft` generated no CSS for months.
6. **`position: fixed` inside the sidebar** renders off-screen; the `<aside>` sets a `translate`, making it a containing block. Portal to `document.body`.
7. **`DT.scheduledDate` is not a clock** — 6,659 of 6,753 rows pinned at exactly 10:00 IST. Window on `items.updatedAt`.
8. **`Odoo.sml.date` is posting time, not movement time** — roughly half post the next day; vendor PO receipts post +2/+3.

---

## Layout

```
lib/engine/       run.ts (orchestrator) · ladder.ts (14 rungs) · buckets.ts
                  (VARIANCE_META, REAL/INFO) · variance-names.ts · suppressions.ts
                  · views.ts · barcode.ts
lib/connectors/   sheets · odoo (via Metabase) · dt (Mongo) · guard · ocr/*
                  · ist-window.ts · warehouse-calendar.ts
lib/reconcile/    pipeline.ts (nightly sequence) · settle.ts · cron-dates.ts
lib/gate/         sync.ts · auth.ts · config.ts · expected.ts · fleet.ts
                  · completeness.ts
lib/db/           schema.ts · persist.ts
app/api/          route handlers; all wrapped in jsonRoute() (lib/api/json-route.ts)
supabase/migrations/   0001 … 0035, applied by hand in the SQL editor
```

Adding a variance name needs **three files in lockstep** (`variance-names.ts`,
`buckets.ts`, the ladder) plus a digest label.

---

## Changing the engine

Unit tests are necessary and not sufficient. The only trustworthy method:

```
1. Harness: replay stored source_rows for a date range through runReconciliation,
   scoped to ONE run_id per day.
2. Run → save output.
3. git stash the change → run again → save output.
4. git stash pop → diff.
```

Both sides share the harness, so its inaccuracies cancel. **Expect only the rows you
predicted to move; anything else is a regression.** Two earlier attempts were invalid
and both looked plausible — one produced +10,981 phantom duplicates by replaying
multi-run rows, the other passed defaults the real run never uses.

---

## Conventions

- `feat(scope):` · `fix(scope):` · `polish(scope):` · `docs(scope):`
- The body explains **why**, including measurements and rejected alternatives.
- Author is **Shantanu Bhadada**. Add a `Co-Authored-By` trailer for anyone who
  actually worked on that commit — the handover docs still say "no trailer", but the
  history has carried them for months, so treat the trailer as normal and the doc as stale.
- Secret-scan the staged diff before every push.
- `.env*.local`, `*.xlsx/xls/csv/pdf`, `/reports/` are gitignored (customer PII).
- **Comment the why, never the what** — especially the constraint that stops the next person "fixing" something deliberate.
- **Measure, don't assert.** Query the live DB before claiming behaviour. Report disproved hypotheses; one guess about the biggest REAL category was wrong (4 of 592) and saying so was more useful than shipping it.

---

## Known broken / in flight

- **`npm run build` fails** — `FATAL ERROR: JavaScript heap out of memory` in the TypeScript phase; compilation itself succeeds. Pre-existing, confirmed by stash-testing the baseline. Likely cause is in the build's own warning: stray `package.json` + `package-lock.json` in the developer's home directory make Next infer `~` as the workspace root. Fix with `turbopack.root` in `next.config.ts`, or remove the strays.
- **Gate app is a silent pilot.** `GATE_APP_CITIES` is unset, so all five cities still read the OCR'd paper register; nothing the app records reaches reconciliation. Flipping a city is a config change, not development.
- **Every geofence check has failed** (39/39) with GPS accurate to 13m — the five site pins came from Plus Codes and none has been confirmed on site.
- **Face check passes 5 times in 27** (10 × `no_face`). Needs diagnosis before attendance can be relied on.
- **Expected-list coverage ~24 rows/day** against ~1,451 real movements. Why `EXPECTED_CHECK_LIVE` stays false.
- **Demo mode is stale** — with Supabase unconfigured the app falls back to a demo store that models an older product (quantity deltas, `HIGH/MEDIUM/LOW`, an `.xlsx` upload flow). It will teach you the wrong domain model. It is not a spec.

## Open, needing a business decision

- **Thursday weekly-off overlap.** Mumbai/Hyderabad/Pune close Thursday, but the business day runs Thu 15:00 → **Fri 15:00** and so contains Friday-morning working hours. The engine treats the whole date as closed and suppresses same-day REALs — a likely weekly leak in three of five cities. Raised three times, unanswered. Do not "fix" it in code without a decision.
- **Mumbai at 32.9% accuracy**, 338 `Ops Sheet Only`. Largest single signal in the data.
