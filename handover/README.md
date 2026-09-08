# handover/ — what to read, and what to distrust

Read in this order. The first two are current; the rest are a record of how the
system got here, and are wrong in places.

## Current — start here

| File | For | Time |
|---|---|---|
| **`field-guide.html`** | Anyone. The domain, in plain language, no code. Open it in a browser | ~30 min |
| **`backend-notes.md`** | Engineers. Architecture, the engine, the invariants, the traps, current state | ~1 hr |

`../CLAUDE.md` is the short operational version, loaded automatically by Claude
in this repo. If it and `backend-notes.md` disagree, `CLAUDE.md` is newer.

`field-guide.html` also exports to PDF for sharing outside the team. The PDF is
not committed (`*.pdf` is gitignored — guard registers are PDFs of customer
records); regenerate it from the HTML.

## Historical — accurate about *why*, stale about *what*

`prompt.md` · `skills.md` · `handout.md` · `conversation-summary.md`

Written mid-2026 and never updated. Still worth reading for the reasoning behind
decisions — the measurements, the rejected alternatives, the bugs that produced a
rule. **Do not trust their facts.** Known to be wrong:

- Describe **migration 0012** as current. There are **35**.
- Quote the reconcile at **16:00/16:30 IST** and the digest at 16:15. Both moved: **20:00** and **21:00**, reconciling **D-2**, not D-1.
- Say **110 tests**. There are **789**.
- Predate the **entire gate subsystem** (migrations 0023–0035, the guard app at `/scan`) — the largest thing in the codebase goes unmentioned.
- Claim `*.pdf` is gitignored. It was not, until Sept 2026.
- `prompt.md` gives a Windows repo path from a previous machine.

## The rule that applies to all of it

Every document here is a snapshot, including the current two. Verify against the
code and the live database before acting on any number. The project's own
working agreement says it best: **measure, don't assert.**
