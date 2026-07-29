// The marker resolveStaleOpenVariances leaves on a row whose gap has cleared.
//
// It lives here, alone, because it is written in lib/db and read in lib/ui and
// the two must never drift. A row carrying this note is resolved even though
// its status is still 'open' — the engine simply stopped emitting it.
//
// WHY A NOTE AND NOT THE BUCKET. For most names a downgrade is legible from the
// data: the name's natural bucket is REAL, the stored bucket is INFO, so
// something downgraded it. But five of the six tier-2 names ("Register Gap":
// Ops+Odoo missing gate, no DT scan, DT+Odoo missing sheet, DT scan pending,
// gate+Odoo only) are natural INFO — setting bucket='INFO' on them changes
// nothing, so the downgrade is invisible in every column except this one.
//
// Without it those five could only ever be cleared by a human, and they are the
// bulk of the amber tier (26 of 27 on 2026-07-27), so the follow-up email would
// report a permanent residue and read as though nothing ever improves.
export const RESOLVED_LATE_NOTE =
  "Entry was made late — this gap had cleared on the next-day re-check. No action needed.";

/** True when the engine has already resolved this row, whatever its status. */
export function isResolvedLate(note: string | null | undefined): boolean {
  return note === RESOLVED_LATE_NOTE;
}
