// The gate register row — the columns a manager reads for every item, in the
// order the paper register and the ops team read them.
//
// ONE DEFINITION for the trip table on screen, the trip's CSV and the day's
// Excel export, so a download can never quietly disagree with the screen.
// Pure: no React, no server imports — the page and the export route share it.

export interface RegisterTrip {
  city: string; direction: string; driverName: string | null; vehicleNo: string;
  guardName?: string; openedAt?: string; closedAt?: string | null;
}
export interface RegisterItem {
  soDisplay: string | null; ticket: string | null; customer: string | null; jobType: string | null;
  itemName: string | null; quantity: number; barcode: string | null; serialNo: string | null;
  entryMethod: string; itemKind: string; notes: string | null;
  lastKnown: boolean; taskDate: string | null;
  duplicateOf: { of: string; ofScannedAt: string; reason: string } | null;
  scannedAt: string;
}

/** "customer_return" → "Customer return", plus the guard's note if any. */
export function manualName(i: Pick<RegisterItem, "entryMethod" | "itemKind" | "notes">): string | null {
  if (i.entryMethod !== "manual") return null;
  // Operations' names where they differ from the stored kind (14 Sep 2026).
  const named: Record<string, string> = { vendor_goods: "New PO" };
  const kind = i.itemKind.replace(/_/g, " ");
  const label = named[i.itemKind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
  return i.notes ? `${label} · ${i.notes}` : label;
}

/** "2026-03-08" → "8 Mar 2026". Parsed as a plain date: no timezone shift. */
export const shortDate = (d: string) => {
  const [y, m, day] = d.slice(0, 10).split("-").map(Number);
  return `${day} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m - 1]} ${y}`;
};

/**
 * `lookedUp` marks the columns filled from Odoo/DT by barcode after the scan
 * rather than recorded at the gate — shown as "…" while the lookup runs. A
 * dash afterwards means no task matches this movement, which is common and
 * true (vendor stock, internal transfers), not a failure.
 */
export const REGISTER_COLUMNS: {
  label: string; mono?: boolean; lookedUp?: boolean;
  /** Free text that may wrap onto a second line rather than widen the table. */
  wrap?: boolean;
  value: (trip: RegisterTrip, it: RegisterItem) => string | null;
}[] = [
  { label: "City", value: (t) => t.city || null },
  { label: "SO Number", mono: true, lookedUp: true, value: (_, i) => i.soDisplay },
  { label: "Ticket ID", mono: true, lookedUp: true, value: (_, i) => i.ticket },
  { label: "Customer Name", lookedUp: true, wrap: true, value: (_, i) => i.customer },
  { label: "Job Type", lookedUp: true, wrap: true, value: (_, i) => i.jobType },
  // A hand entry has no product to look up — a box of spares, a PP box, a
  // vendor delivery. Its kind and the guard's note ARE the item name, and
  // showing a dash there made the entry look like it was never recorded.
  { label: "Item Name", lookedUp: true, wrap: true, value: (_, i) => i.itemName ?? manualName(i) },
  // Dropped once when the register columns replaced the old table, which hid
  // that "PO-TYUI-BJ900" was ten washing machines.
  { label: "Qty", value: (_, i) => String(i.quantity) },
  { label: "Movement Type", value: (t) => (t.direction === "OUT" ? "Outward" : "Inward") },
  // Raw scanned spelling — never the fold.
  { label: "Barcode", mono: true, value: (_, i) => i.barcode ?? i.serialNo },
  { label: "Agent", wrap: true, value: (t) => t.driverName },
  // Wraps at its own hyphens ("VIPIN-EV-" / "DL1LAT4654"): DT's transport text
  // is the widest thing in the row and repeats on every line of the trip.
  { label: "Transport", mono: true, wrap: true, value: (t) => t.vehicleNo },
];

const istTime = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata" });
const istDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", hour12: false }).replace(",", "");

/** The columns a FILE carries after the register: what a spreadsheet row cannot
 *  show as a badge or a greyed-out line has to be written out. */
export const FILE_HEADER = [...REGISTER_COLUMNS.map((c) => c.label), "Details From", "Duplicate", "Entry", "Guard", "Scanned At"];

export function fileRow(trip: RegisterTrip, it: RegisterItem): (string | null)[] {
  return [
    ...REGISTER_COLUMNS.map((c) => c.value(trip, it)),
    // A March ticket in a September export must still say it is last known.
    !it.ticket && !it.jobType && !it.customer ? ""
      : it.lastKnown ? `Last known task${it.taskDate ? ` (${shortDate(it.taskDate)})` : ""}` : "This movement",
    it.duplicateOf ? `Yes — ${it.duplicateOf.reason} as the ${istTime(it.duplicateOf.ofScannedAt)} entry; not counted` : "",
    it.entryMethod,
    trip.guardName ?? "",
    istDateTime(it.scannedAt),
  ];
}
