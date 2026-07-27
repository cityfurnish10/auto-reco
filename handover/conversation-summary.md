# Conversation Summary — what was asked, what was built, what was measured

A chronological record of this working session on the CityFurnish auto-reco
platform. Every claim with a number was measured against the live database or a
live connector, not estimated.

---

## 1. UI/UX audit and fixes

**Asked:** "Suggest what more things can be improved in terms of UI design, flow etc" → then "start where u left".

Delivered a prioritised report, then implemented it across four commits.

### Verified defects that were fixed

| Defect | Evidence |
|---|---|
| A blank date filter meant **every date ever**, not the latest run | Live: table showed **6,594 rows** under a **278**-row KPI headline |
| Stats fallback ordered runs by `created_at`, picking a re-check pass | Live: resolved **2026-07-24** from a run created **48s after** the 2026-07-25 one |
| Mobile cards had no click handler — detail dialog unreachable on a phone | Code inspection; managers are phone-first |
| Export mapped over the visible page | 340 filtered rows → a 25-row file with a confident filename |
| `bg-accent-soft` used 12× but never declared in Tailwind config | Generated no CSS; OCR spinner rendered as a solid circle |
| `.btn-primary` hardcoded `#ffffff` on a lavender dark-mode accent | **~2.9:1** contrast, below WCAG AA |
| Four icon names rendered blank squares | `refresh`, `verified`, `arrow_back`, `forward_to_inbox` — two were mine |
| Sidebar toast rendered off-screen on mobile | The `<aside>`'s `translate` makes it a containing block for `position:fixed` |

### Then a broader polish pass
Type floor raised (`text-sm` was **smaller** than `text-base`), global `:focus-visible`
(only `.btn` had one), loading skeletons, honest empty states, page-index clamping
("Page 8 of 7"), the users slide-over moved onto the modal primitive, and the
analytics charts given axes — they floored at 60% with no reference line, and
**silently deleted failed nights** from the trend rather than showing a gap.

---

## 2. Capabilities: bulk actions, sorting, filters, toasts

**Asked:** four missing capabilities, "commit in 6-7 batches".

- **Bulk actions** — checkboxes, select-all with indeterminate state, shift-click
  ranges, a docked action bar. `PATCH /api/variances/bulk` reuses the single-row
  `buildUpdate` (extracted to a shared module rather than copied).
- **Column sorting** — 13 whitelisted keys, server-side. `priority`/`status` needed
  **migration 0011** because they are TEXT with CHECK constraints: ordering
  alphabetically gives "High, Info, Medium" and puts `closed` before `open`.
- **Ops-type and owner filters** with a facets endpoint.
- **Toast + confirm system** replacing **14 `alert()` and 4 `window.confirm()`**.

### Measured
`order=status.asc` gave `closed, in_progress, open`; `status_rank` gives
`open, in_progress, closed`. Ranks verified correct on **all 6,594 rows**.

**Correction issued:** I claimed the priority sort was broken in practice. The
rank column is right, but the data contains **no Medium-priority rows at all** —
so alphabetical and rank orderings coincided. `status_rank` fixed a genuine live
defect; `priority_rank` prevents a future one.

---

## 3. Pending List, ops-type filter, engine done/not-done, date picker

**Asked:** five changes. Decisions taken: Pending List as a **closure reason**
(no new status), "Validation Error" as a **new reason**, engine fix **without**
connector changes.

### The engine defect, precisely

The failed-delivery rule required **every** source's status to be `not_done`:

```ts
if (statuses.length === 0 || !statuses.every((s) => s === "not_done")) continue;
```

DT, Odoo and the guard register all hard-code `status: "done"` because each
filters to completed rows upstream. So a gate-confirmed failed delivery could
**never** satisfy it — it fell through to ladder rung 3 and was classified a REAL
loss while the unit sat back in the warehouse.

**A/B replay, identical harness both sides, 2026-07-20…25:**

| | |
|---|---|
| −49 REAL | `Gate + Ops Confirm — No DT Scan or Odoo Post` |
| −19 REAL | `Same Unit In + Out Today` (out-and-back failed deliveries) |
| +12 REAL | `Failed Delivery — Return Not Logged Inward` (reclassified) |
| +5 REAL | `Ops Sheet Says Not Delivered — Posted Done in DT/Odoo` (new) |
| **Net** | **1,024 → 973. Nothing else moved.** |

**A hypothesis I tested and disproved:** I suspected the biggest REAL category
(`Ops Sheet Only`, 592) was failed deliveries. It was not — only **4 of 592 (1%)**.
Said so rather than letting it look like a miss.

---

## 4. Spare/PP-box detection from the item name

**Asked:** "in spare parts, when there is PP box, or in google sheet there is not
found in the item name -> that is most probably a sparepart entry or consumable".

Correct, and measurable: **366 sheet rows** carry the item name "Not Found" — the
floor types a description into the barcode column (`WP water seal - 13`,
`Spin Motor - 3`) and the product lookup resolves nothing.

**The guard the data forced.** Of 219 such rows with a plausible barcode, **217
appeared in no other system** and were genuine spares — but **2 were real Odoo lot
serials** (`FUCQPU26070002`, "# Luna Wardrobe") whose sheet line simply had a blank
product column. Reclassifying those would have erased a real PO receipt. So a
barcode any serialized system knows can never be reclassified by sheet text.

**A/B: −36 REAL, none added** (35 of them `Ops Sheet Only`, exactly the false loss
a spare produces). REAL 967 → 931.

---

## 5. The 15:00 business day, per-source counts, register PDFs

**Asked:** re-base the day to 3PM–3PM, add IN/OUT counts per source to the email,
attach the register as a PDF, flag missing registers.

### Source clocks — measured before deciding

| Source | Field | Finding |
|---|---|---|
| Odoo | `sml.date` | Real timestamp, spread across the day. **75%** of postings land before 15:00 |
| DT | `scheduledDate` | **6,659 of 6,753 pinned at exactly 10:00 IST** — a date marker, not a clock |
| DT | `items.updatedAt` | Real completion time, evening peak 17:00–21:00. **Used instead** |
| Sheet / Guard | typed date | No time exists. Matched by date; covered by the before-16:00 process rule |

**DT A/B:** 1,479 → 1,486 rows (+0.5%) — redistribution, not loss.

### Also built
Migration **0012** (12 columns), the Movement Summary table, missing-register
callouts, the incomplete-run banner, per-city register PDFs, and a sticky date
picker.

---

## Bugs I caught in my own work

1. **PDF was 4.5× duplicated** — filtered `source_rows` by `business_date` alone;
   `source_rows` retains every re-check pass. 4,106 rows for a day the run pulled
   896. Now scoped to `run_id`.
2. **The digest cron would have silently skipped.** Switching `.lte()` → `.eq()`
   made a missing run return "skipped" — the opposite of the chosen behaviour.
3. **Two invalid A/B replays.** The first produced +10,981 phantom duplicates
   (multi-run rows); the second passed defaults the real run didn't use. Only the
   same-harness-both-sides design is trustworthy.
4. **`vercel.json` `_comment` keys broke the deploy.** `npm run build` never
   validates that file — only `vercel build` does.
5. **A corrupted `node_modules` file** — `@typescript-eslint/scope-manager` had a
   Google Chat payload written into line 526. Reinstalled; likely OneDrive sync.

---

## Open items, unresolved

1. **Thursday weekly-off overlap.** Business day Thursday now spans Thu 15:00 →
   **Fri 15:00**, so it contains Friday-morning working hours. The engine still
   treats those dates as "nothing could move" and suppresses same-day REALs —
   a potential weekly leak for Mumbai, Hyderabad and Pune. Raised three times.
2. **Mumbai at 32.9% accuracy, 338 "Sheet only".** Predates all of this work, but
   is the largest signal in the data and is about to reach founders daily.
3. **`Medium` priority appears unreachable** — no row in the data has it.
4. **Ops-sheet free text leaking into `job_type`** — `Replacement 4`, `Repless.`,
   `Delivery not done` appear as distinct ops types.
