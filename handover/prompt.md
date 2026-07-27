# Prompt — context for picking this work up

Paste into a fresh session (or hand to a new engineer) to resume with full
context. Everything below is verified against the live system.

---

## What this is

**CityFurnish auto-reco** — a warehouse reconciliation platform for 5 cities
(Delhi, Mumbai, Pune, Hyderabad, Bangalore). Each night it pulls four independent
records of stock movement, matches them per barcode per direction, and produces a
chase list of genuine gaps plus a daily email to founders.

Repo: `c:\Users\nisha\OneDrive\Desktop\auto-reco` · deployed on Vercel ·
GitHub `cityfurnish10/auto-reco`.

---

## The core model, in one page

**A business day runs 15:00 → 15:00 IST.** Date D covers D 15:00 → D+1 15:00.
Reconcile at 16:00 on D+1, email at 16:15.

**Four sources**, only two of which carry a real clock:

| Source | Field | Windowed on 15:00? |
|---|---|---|
| PHYSICAL (guard register) | `guard_uploads.business_date` | No — typed date |
| SHEET (ops Google Sheet) | a date cell | No — typed date |
| DT (MongoDB) | `items.updatedAt` | **Yes** |
| ODOO (via Metabase) | `sml.date` ±1 day | **Yes** |

**Pipeline:** OCR pending registers → `pullAll` (4 connectors, per-city split) →
drop PP boxes / spares / invalid barcodes → build `BarcodeView` per canonical
barcode per direction → suppressions → failed-delivery rule → ladder → bucket
REAL/INFO → direction-conflict (CROSS) → persist → per-city stats → prune.

**The ladder** (`lib/engine/ladder.ts`) classifies on the presence pattern of
P/S/D/O, first match wins, 14 rungs. Every rung that blames a source for an
absence gates on `rep.X` — that source actually reported. **A source that did not
report is never blamed.**

**The bucket** is a property of the variance *name*, looked up in
`VARIANCE_META` (`lib/engine/buckets.ts`). REAL = chase today. INFO = hygiene.

**Only completed movements reconcile.** The ops sheet's Physical Status is the
only field carrying an outcome; DT/Odoo/guard hard-code `done` because they filter
to completed rows upstream. A sheet `Not Delivered` means DT/Odoo silence is
*expected*, so no variance — unless the return was never logged inward, or unless
DT/Odoo positively posted it done (they contradict each other).

---

## Files that matter most

| Path | Why |
|---|---|
| `lib/engine/run.ts` | Orchestrator — spare/PP split, views, failed-delivery rule, bulk-SO collapse |
| `lib/engine/ladder.ts` | The 14 classification rungs |
| `lib/engine/buckets.ts` | `VARIANCE_META` — REAL/INFO, owner, explanation |
| `lib/engine/variance-names.ts` | The canonical strings. Adding one needs **3 files in lockstep** + digest label |
| `lib/engine/suppressions.ts` | 7 rules that remove a view before classification |
| `lib/engine/views.ts` | `BarcodeView`, `hasDone`, `sheetSaysNotDone`, `postedDone` |
| `lib/connectors/ist-window.ts` | Calendar vs business day. **Read the header before touching dates** |
| `lib/reconcile/pipeline.ts` | The nightly sequence |
| `lib/email/digest.ts` | Data shape + HTML/text renderers |
| `lib/db/persist.ts` | Upserts. Deliberately never overwrites human closures |

---

## Traps that have already caused bugs

1. **PostgREST caps un-ranged selects at 1,000 rows.** Paginate aggregates.
2. **`source_rows` holds every re-check pass.** Scope to `run_id`, or you get
   ~4.5× duplicates.
3. **Window and attribution must move together.** Re-basing a connector's pull
   window without `utcToBusinessDate` silently reclassifies half of Odoo.
4. **RLS is the security boundary.** Cookie client for user-facing reads;
   `createAdminClient()` bypasses RLS entirely.
5. **Migrations are applied by hand.** Ship code that degrades on `42703`.
6. **`vercel.json` is unvalidated locally**, strict JSON, no comments.
7. **Tailwind scans `lib/**`** — class strings must be literal.
8. **`position:fixed` inside the translated sidebar** renders off-screen; portal it.

---

## How to verify an engine change

Unit tests are necessary but not sufficient. The trustworthy method:

```
1. Write the harness: replay stored source_rows for a date range through
   runReconciliation, scoped to ONE run_id per day.
2. Run it → save output.
3. git stash the change → run again → save output.
4. git stash pop → diff the two.
```

Both sides share the harness, so its inaccuracies cancel and the delta is
attributable purely to the change. **Expect only the rows you predicted to move;
anything else is a regression.**

Two earlier attempts were invalid — one produced +10,981 phantom duplicates by
replaying multi-run rows, the other passed `reported`/`recentFloor` defaults the
real run never uses. Both looked plausible.

---

## Working agreements

- **Measure, don't assert.** Query the live DB before claiming behaviour.
- **Report disproved hypotheses.** One guess about the biggest REAL category was
  wrong (4 of 592) and saying so was more useful than shipping it.
- **Commit in batches** with a *why*-first body; **author nishantgawderya1 only,
  no Co-Authored-By trailer**; **secret-scan the staged diff before pushing**.
- **Run** `npx tsc --noEmit && npm run lint && npm test && npm run build`.

---

## Current state

All work through migration **0012** is shipped and pushed. Migrations 0001–0012
applied. 110 tests pass.

### Open, needing a decision
1. **Thursday weekly-off overlap** — business day Thursday now runs Thu 15:00 →
   Fri 15:00, so it contains Friday-morning working hours, but the engine still
   treats the date as closed and suppresses same-day REALs. A likely weekly leak
   for Mumbai, Hyderabad, Pune. **Raised three times, still unanswered.**
2. **Mumbai: 32.9% accuracy, 338 `Ops Sheet Only`.** Predates this work; the
   largest signal in the data.
3. **`Medium` priority is unreachable** — no row has it. Either the ladder never
   emits it or the filter option is dead weight.
4. **Ops-sheet free text leaking into `job_type`** — `Replacement 4`, `Repless.`,
   `Delivery not done` appear as distinct ops types.

### Deliberately not done
- **Odoo/DT do not fetch non-complete rows.** The engine infers "in transit" from
  absence rather than seeing it. Changing that is a connector-level decision with
  its own ingest-volume cost.
- **The register PDF is built from sheet rows, not exported from Google.** The
  export needs `drive.readonly` added in Cloud Console and renders the whole tab
  (~1,500 rows), not one date.
