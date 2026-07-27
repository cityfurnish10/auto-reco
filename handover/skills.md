# Skills — what it takes to work on this codebase

The competencies someone needs to change this system safely, and the
project-specific knowledge that is not obvious from the code.

---

## Stack

| Area | Technology | Notes |
|---|---|---|
| Framework | **Next.js 16** App Router, React 19, TypeScript strict | Server components resolve the session; dashboards are client components |
| Styling | **Tailwind v4** via `@config` hybrid | Tokens in `globals.css` as CSS vars, mapped in `tailwind.config.ts` |
| Database | **Supabase** — Postgres + RLS + Auth + Storage | RLS is the security boundary, not app code |
| Hosting | **Vercel** (region `bom1`), Hobby tier | 2 cron max, `maxDuration = 60` |
| Email | **nodemailer** over Gmail SMTP | `resend` is installed but unused |
| PDF | **pdf-lib** | Pure JS, standard fonts, no native deps |
| External | Metabase→Odoo (SQL), MongoDB (DT), Google Sheets + Drive, Azure Document Intelligence (OCR) | |
| Tests | **Vitest** — 110 tests, engine-heavy | |

---

## Non-obvious things that will bite you

### 1. PostgREST caps un-ranged selects at 1,000 rows
Silently. This caused a live bug where KPI cards showed "169 REAL" for a run that
held 555. **Always paginate** aggregate reads — the pattern is in
`app/api/stats/summary/route.ts`.

### 2. `source_rows` holds every re-check pass for a date
Filtering by `business_date` alone returns the same movement several times.
Measured: **4,106 rows for a day the run pulled 896**. Scope to `run_id`.

### 3. Two day definitions coexist, and mixing them corrupts data
- `utcToIstDate` — **calendar** day. For things that really are calendar days.
- `utcToBusinessDate` — **business** day (15:00 IST). For movement attribution.

The engine decides REAL vs INFO by comparing an Odoo posting's date to the run
date. Change a connector's *window* without changing its *attribution* and you
silently reclassify every posting made after 15:00, with no error anywhere.

### 4. RLS does the authorisation; never bypass it for reads
`variances_select` scopes managers to `city = auth_city()`. Any new page that
lists variances gets city-scoping for free **if** it uses the cookie-bound client
(`lib/supabase/server`). Using `createAdminClient()` bypasses RLS and leaks every
city. That client is only for role lookup and cron jobs.

### 5. Migrations are applied by hand, so code must not assume them
There is no direct Postgres URL in the environment. Ship code that **degrades**:
- `saveCityStats` catches `42703` and retries without the 0012 columns. Without
  that, an unapplied migration would fail the whole nightly reconcile.
- `/api/variances` catches it for `priority_rank` and reports `sortDegraded`.

### 6. `vercel.json` has no local safety net
`npm run build` never validates it — only `vercel build` does. It is strict JSON,
rejects unknown keys, and **cannot hold a comment**. Adding `_comment` to a cron
entry broke a deploy while every local check passed.

### 7. Tailwind scans `lib/**` for class names
Class strings in `lib/ui/*` must stay **literal**. A computed or concatenated
class generates no CSS. Twelve uses of `bg-accent-soft` produced nothing for
months because the token was never declared in the config.

### 8. `position: fixed` inside a transformed ancestor
The sidebar sets a `translate`, which makes it a containing block. A toast
rendered inside it positions against an off-screen drawer on mobile. **Portal to
`document.body`.**

---

## Domain knowledge

### The four sources are not equal
Only the **ops sheet** carries a delivery *outcome*. DT, Odoo and the guard
register hard-code `done` because each filters to completed rows upstream —
their "done" means *a record exists*, not *the movement succeeded*.

### Reported-awareness
A source that did not report is never blamed for an absence. Without this, a
Metabase outage reads as hundreds of HIGH variances. Every ladder rung that
blames a source gates on `rep.X`. A **zero count is not the same as not
reporting** — which is why `run_city_stats` stores both.

### Field quirks measured on live data
| Field | Reality |
|---|---|
| `DT.scheduledDate` | 6,659 of 6,753 pinned at 10:00 IST — a date marker, not a clock |
| `DT.items.updatedAt` | Real completion time (evening peak). This is what to window on |
| `Odoo.sml.date` | Posting time, not movement time. ~half post next day |
| `Odoo.procurement_status` | Becomes `jobType` but is `ok`/`new`/`damaged` — not an ops type |
| Sheet `product` = "Not Found" | Usually a spare: a description was typed into the barcode column |
| Sheet dates | Delhi writes `7/13` (month-first), Hyderabad `13-07` (day-first) |

---

## Working practices this codebase expects

### Measure before you claim
Every behavioural claim here was checked against the live database. A hypothesis
that the biggest REAL category was failed deliveries turned out to be **4 of 592
(1%)** — reporting that honestly was more useful than shipping the assumption.

### A/B with an identical harness on both sides
The only trustworthy way to measure an engine change. Two earlier attempts were
invalid: one produced **+10,981 phantom duplicates** (multi-run rows), the other
passed defaults the real run never uses. The valid design is: run the harness,
`git stash` the change, run it again, diff.

### Comment the *why*, never the *what*
Especially the constraint that stops the next person "fixing" something. The DT
connector's calendar-day comment exists so nobody re-windows it without
re-measuring.

### Ordering matters when schema and code change together
Both naive orders can break the nightly run. Ship the defensive change first,
then the migration, then the code that depends on it.

---

## Commit conventions

- `feat(scope):` · `fix(scope):` · `polish(scope):` · `docs(scope):`
- The body explains **why**, including measurements and rejected alternatives.
- Author is **nishantgawderya1** only. **No `Co-Authored-By` trailer.**
- **Scan the staged diff for secrets before every push.**
- `.env*.local`, `*.xlsx/xls/csv/pdf` and `/reports/` are gitignored (customer PII).

## Before every push

```bash
npx tsc --noEmit && npm run lint && npm test && npm run build
```
