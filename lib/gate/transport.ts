// One truck, however it was spelled — and its visits to the gate.
//
// WHY. The same vehicle reaches the gate under many spellings: picked from DT's
// list ("VIPIN-EV-DL1LAT4654", "MT - T - DL-1L-AN9769") or typed by a guard
// ("DL1LAT 4654", "DL 1LAN 9769"). Measured on Delhi's first live days, 10–14
// Sep 2026: 31 distinct spellings for 16 vehicles. Filtering or grouping on the
// raw text would split one truck into four.
//
// Pure functions with no imports, shared by the Activity API (filtering), the
// page (grouping) and the DT fleet reader, so all three agree on what "the same
// truck" means — and the page can run them without bundling any server code.


const PLATE_ANYWHERE = /[A-Z]{2}\d{1,2}[A-Z0-9]{0,4}\d{4}/g;
export const PLATE_RE = /^[A-Z]{2}\d{1,2}[A-Z0-9]{0,4}\d{4}$/;

export function plateOrNull(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  let last: string | null = null;
  let m: RegExpExecArray | null;
  PLATE_ANYWHERE.lastIndex = 0;
  while ((m = PLATE_ANYWHERE.exec(s)) !== null) {
    last = m[0];
    // Advance by one rather than by the whole match, so an overlapping later
    // plate is still found.
    PLATE_ANYWHERE.lastIndex = m.index + 1;
  }
  return last;
}

/** The registration inside whatever was recorded; failing that, the text with
 *  separators stripped. Never shown on its own — the recorded spelling is. */
export function transportKey(vehicleNo: string | null | undefined): string {
  const raw = String(vehicleNo ?? "");
  return plateOrNull(raw) ?? raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * An agent, case and spacing aside. "Kavi saroj" and "Kavi Saroj" are one
 * person. "Sudhir" and "Sudhir Kumar" are deliberately NOT merged: a first name
 * shared by two agents is common, and folding them would put one person's
 * trips under another's name.
 */
export function agentKey(name: string | null | undefined): string {
  return String(name ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** The spelling to show for a key: the one used most often, ties to the first. */
export function commonestSpelling(values: string[]): string {
  const n = new Map<string, number>();
  for (const v of values) n.set(v, (n.get(v) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

export interface VisitTrip {
  id: string; vehicleNo: string; openedAt: string; closedAt: string | null;
  /** The last item scanned on the trip, when known. */
  lastActivityAt?: string | null;
}

/**
 * When a trip really ended, for the purpose of the gap.
 *
 * The last item scanned, not the close. Delhi, 13 Sep 2026: an inward trip on
 * DL1LAH3979 opened at 20:16 and was not closed until 09:57 the next morning, so
 * measuring from the close merged that evening's return with the next day's
 * outward load into one "visit". The last scan is when the truck was last
 * actually being worked; the close is when somebody remembered to press it.
 */
function endOf(t: VisitTrip): string {
  const scanned = t.lastActivityAt ? Date.parse(t.lastActivityAt) : NaN;
  if (!Number.isNaN(scanned)) return t.lastActivityAt!;
  return t.closedAt ?? t.openedAt;
}

export interface Visit<T extends VisitTrip> {
  key: string;
  trips: T[];
  /** First trip opened … last item scanned (or close, or open, when no scans). */
  start: string;
  end: string;
}

/**
 * Group trips into visits: same truck, and each trip starting within `gapMs` of
 * the previous one's last scanned item (see endOf). A longer gap starts a new visit — a truck loaded at
 * 10:00 and back at 19:00 is two visits, while an outward trip closed at 10:12
 * and a second one opened at 10:50 for the forgotten items is one.
 *
 * Newest visit first; trips inside a visit in the order they happened.
 */
export function groupVisits<T extends VisitTrip>(trips: T[], gapMs: number): Visit<T>[] {
  const byKey = new Map<string, T[]>();
  for (const t of trips) {
    const k = transportKey(t.vehicleNo);
    byKey.set(k, [...(byKey.get(k) ?? []), t]);
  }
  const visits: Visit<T>[] = [];
  for (const [key, list] of byKey) {
    list.sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt));
    let cur: Visit<T> | null = null;
    for (const t of list) {
      const end = endOf(t);
      if (cur && Date.parse(t.openedAt) - Date.parse(cur.end) <= gapMs) {
        cur.trips.push(t);
        if (Date.parse(end) > Date.parse(cur.end)) cur.end = end;
      } else {
        cur = { key, trips: [t], start: t.openedAt, end };
        visits.push(cur);
      }
    }
  }
  return visits.sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
}
