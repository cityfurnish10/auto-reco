// Dates the way the warehouse says them.
//
// Parsed as UTC parts rather than `new Date(iso)` in local time, which shifts a
// date across midnight for anyone west of UTC and would have the assistant name
// the wrong day.

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "an unknown date";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m;
  return `${Number(d)} ${MONTHS[Number(mo) - 1]} ${y}`;
}
