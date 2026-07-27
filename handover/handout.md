# Handout — How the reconciliation works

For anyone operating or reading the output of the auto-reco platform. No code.

---

## 1. The daily cycle

A **business day runs 15:00 → 15:00 IST**. Business date **25 July** covers
25 July 15:00 until 26 July 15:00. That matches the floor: the guard register is
ruled off and handed over mid-afternoon, not at midnight.

| Time (IST) | What happens |
|---|---|
| **15:00** | The business day closes |
| **before 16:00** | Ops must have the guard register uploaded and the ops sheet filled |
| **16:00** | Reconciliation runs — OCR, all four sources, the engine |
| **16:15** | Digest email goes out for the day just reconciled |

So 25 July is reconciled at 16:00 on the **26th** and emailed at 16:15 the **same
afternoon**.

**The 16:00 deadline is real.** The register arrives around 16:00 and the run
starts at 16:00, so anything uploaded late misses that night. When it does, the
email says so by name — that is not a bug, it is the design working.

---

## 2. The four sources

| Name in the email | System | What it proves |
|---|---|---|
| **Security Guards** | Guard register (scanned, OCR'd) | The unit physically crossed the gate |
| **Register** | Ops Google Sheet | What the warehouse team recorded, **and whether it completed** |
| **Delivery Tracker** | DT app (MongoDB) | The field agent's scan |
| **Odoo** | Odoo stock moves | The book entry |

### Which clock each one is on

Only two carry a real timestamp, so only two can honour the 15:00 boundary:

- **Odoo** — windowed on 15:00–15:00 (posting time)
- **Delivery Tracker** — windowed on 15:00–15:00 (completion time)
- **Ops sheet** and **guard register** — matched on the date somebody typed,
  because no time exists in the data

**Consequence, stated plainly:** for a movement that happened in the *morning*, the
sheet says day D while Odoo says D−1. The Register and Odoo columns in the email
will therefore not tie out exactly for morning movements. The engine allows for
this when matching, so it does not create false losses — but do not read the two
columns as though they should be equal.

---

## 3. Only completed movements count

This is the rule that decides whether something is a problem.

**The ops sheet's Physical Status is the only field that says whether a movement
finished.** The other three all report `done` because each filters to completed
records before we ever see them — a guard-register "done" means *the unit crossed
the gate*, not *the delivery succeeded*.

So:

| Situation | Result |
|---|---|
| Sheet says **Delivered/Received**, DT or Odoo has no record | **Variance** — chase it |
| Sheet says **Not Delivered**, DT and Odoo silent | **Not a variance** — a failed delivery is rightly absent |
| Sheet says **Not Delivered**, and the return was never logged inward | **Variance** — "Failed Delivery — Return Not Logged Inward" |
| Sheet says **Not Delivered**, but DT or Odoo posted it **done** | **Variance** — the systems disagree, one is wrong |

---

## 4. REAL vs INFO

Every variance is bucketed:

- **REAL** — a genuine gap. Chase it today. This is the number in the subject line.
- **INFO** — data hygiene: posting lag, a barcode typo, a missing scan where three
  other systems agree. Kept for audit, excluded from the loss count.

The bucket is a property of the *variance type*, not of the individual row.

### REAL types (the chase list)

| Name | Means |
|---|---|
| Wrong Barcode Scanned in DT | The agent scanned the wrong unit |
| Moved on Floor + DT — Not Posted in Odoo | Floor and DT agree; Odoo never got it |
| Gate + Ops Confirm — No DT Scan or Odoo Post | Both floor sources agree; neither system has it |
| Gate Register Only — No Ops / DT / Odoo Record | Only the guard saw it |
| Ops Sheet Only — No Gate / DT / Odoo Record | Only the sheet has it |
| Pickup Logged (Gate + DT) — Odoo Receipt Open | Picked up but Odoo receipt still open |
| DT Only — No Floor or Odoo Record | Only the agent's scan exists |
| Same Unit In + Out Today — Confirm Replacement | In and out on one SO — confirm it is a real swap |
| Failed Delivery — Return Not Logged Inward | Went out, did not deliver, return never written in |
| Ops Sheet Says Not Delivered — Posted Done in DT/Odoo | The sheet and the systems contradict each other |
| Odoo Entry Created Today — No Gate / Ops / DT Record | Born in Odoo today with no floor trace |

### INFO types (audit only, not counted as losses)

| Name | Means |
|---|---|
| Ops + Odoo Confirm — Missing from Gate Register | Sheet and Odoo agree; only the handwritten register missed it. Measured 2026-07-20: 220 of 230 also had a DT scan — three systems confirming, so a register hygiene gap, not a loss |
| Entry Dated Wrong Day — Unit Logged on Adjacent Day | The floor logged it a day either side |
| Odoo Posting Only — No Gate / Ops / DT Record | An Odoo entry with no floor trace, whose record pre-dates today — a late batch-post of an earlier movement |
| Odoo Entry Made Late — Posted Next Day | Odoo has it, posted the following day, and the floor confirms |
| Ops + Odoo Confirm — No DT Scan | The agent's scan is missing; sheet and Odoo agree |
| DT + Odoo Confirm — Missing from Ops Sheet | The sheet missed it; DT and Odoo agree |
| Gate + Ops + Odoo Confirm — DT Scan Pending | Three sources agree, DT scan outstanding |
| Gate + Odoo Confirm — No Ops Sheet or DT Scan | Gate and Odoo agree; sheet and DT silent |
| Ops + DT Confirm — Odoo Posting Pending | Floor sources agree, Odoo not yet posted |
| All Sources Agree — Barcode Text Differs (OCR/Typo) | Everyone has it; the barcode was mis-transcribed |
| Duplicate Scan — Same Barcode Logged Twice | The same unit logged twice within one source |

---

## 5. What never becomes a variance

- **Spares and consumables** — they live in the register, sheet and DT but never in
  Odoo, so they would always look "missing from Odoo". Detected from the barcode,
  the ops type, the item name (including **"Not Found"**, which is how the sheet
  reads when a description was typed into the barcode column) and the remarks
  column. **Safeguard:** a barcode that DT, Odoo or the guard register knows is a
  real tracked unit and is never reclassified, however the sheet describes it.
- **PP boxes** — packing boxes are counted, not reconciled.
- **Weekly off** — Mumbai, Hyderabad and Pune are closed Thursday. Absent data is
  expected and shows as OFF.
- **Source down** — if a connector fails or a city's sheet is empty, that source is
  not blamed for absences. "Source down" never reads as hundreds of losses.

---

## 6. The daily email

1. **Not received for this date** *(red, only when something is missing)* — names
   each city and distinguishes *register not uploaded* / *uploaded but not yet
   processed* / *OCR failed* / *no ops-sheet rows*. Three different asks of three
   different people.
2. **Reconciliation did not complete** *(amber, only when the run failed)* — the
   figures may be stale. The email still sends: an email nobody receives is worse
   than one carrying a warning.
3. **City table** — accuracy, open items, PP boxes, top gap.
4. **Movement Summary** — Out/In per city for Register, Odoo, Delivery Tracker and
   Security Guards. **A red dash means that source did not report — not zero
   movements.**
5. **Attachments** — one register PDF per city, that date's rows only.

---

## 7. Working the queue

- **Needs action** is the default view: open **plus flagged**. Flagging escalates
  to the city manager, so it must not hide from them.
- **Resolving** requires a reason. Options: Pending List · Late entry by team ·
  Backdated issue resolved by the team · Wrong Entry Made by team · Data Entry
  Error · Validation Error · Transit Delay · Theft · System Glitch · Other.
- **Pending List** parks an item on its own page instead of finishing it. City
  managers see only their own city. Parked items still count as closed in the KPI,
  so the Resolved tile names how many are parked.
- **Bulk actions** — select across pages; the bar shows how many of your selection
  are genuinely awaiting approval, so "Approve 30" never silently skips 12.
- **The date picker** is remembered when you navigate away and back. It resets on a
  full page reload.

---

## 8. Known limitations

| Limitation | Consequence |
|---|---|
| Raw source rows kept **7 days** | Re-sending a digest older than that cannot rebuild the register PDF |
| Register/sheet on a typed date | Morning movements can sit on either side of the 15:00 boundary |
| Vercel Hobby cron timing is approximate | The 16:15 email may fire before a slow reconcile finishes — hence the banner |
| Weekly-off days now include the next morning | See the open question below |

**Open question for the business:** a Thursday-off warehouse's business day now runs
Thursday 15:00 → **Friday 15:00**, so it contains Friday-morning working hours. The
engine still treats the whole day as "closed" and suppresses same-day losses. Real
Friday-morning movements may be downgraded every week for Mumbai, Hyderabad and
Pune. This needs a decision.
