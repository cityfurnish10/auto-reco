// IST calendar-day → UTC datetime window (DB MODEL.md §4 / §17). Both Odoo
// and DT store movement timestamps in UTC, but the business "run date" is an
// IST calendar day, so every date filter must convert:
//   runDate 00:00:00 IST    →  runDate-1 18:30:00 UTC   (inclusive start)
//   runDate+1 00:00:00 IST  →  runDate   18:30:00 UTC   (exclusive end)
// Shared by both connectors so the conversion rule lives in exactly one place.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function istDayToUtcWindow(runDate: string): {
  startUtc: string;
  endUtcExclusive: string;
} {
  const [y, m, d] = runDate.split("-").map(Number);
  const startMs = Date.UTC(y, m - 1, d) - IST_OFFSET_MS;
  const endMs = startMs + DAY_MS;
  return {
    startUtc: new Date(startMs).toISOString(),
    endUtcExclusive: new Date(endMs).toISOString(),
  };
}
