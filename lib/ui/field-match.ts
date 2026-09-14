// Does a field agree across the four systems' records for one movement?
//
// Asked for 14 Sep 2026: each field in a variance's detail should show whether
// it matched across all four sources. Pure, so the rules are tested.
//
// WHAT IS COMPARED. Only the records the panel shows — this movement's
// direction — and each field in a normalised form, because the systems spell
// the same value differently (a customer in capitals, an SO with a stray
// space, a barcode with O for 0). Two fields leave Odoo out ON PURPOSE:
//   - ticket: Odoo's ticket_id is its own transfer reference (GUR/IN/20188),
//     not a ticket, so it can never equal DT's or the sheet's;
//   - ops type: Odoo's is a procurement status ("new"), not a job type.
// Comparing those would paint a false "differs" on every row.

import { canonicalize } from "../engine/barcode";

export type MatchSource = "PHYSICAL" | "SHEET" | "DT" | "ODOO";
export interface MatchRow {
  barcode?: string | null; so_number?: string | null; ticket_id?: string | null;
  customer?: string | null; product?: string | null; job_type?: string | null;
  direction?: string | null; date?: string | null; city?: string | null;
}
export type MatchField = "barcode" | "so_number" | "ticket_id" | "customer" | "product" | "job_type" | "direction" | "date" | "city";

export interface FieldMatch {
  /** all: every source that is compared holds it and they agree.
   *  partial: those holding it agree, but not every source holds it.
   *  differ: at least two sources hold different values.
   *  none: no source holds it. */
  state: "all" | "partial" | "differ" | "none";
  compared: MatchSource[];
  holders: { source: MatchSource; value: string }[];
}

const SOURCES: MatchSource[] = ["PHYSICAL", "SHEET", "DT", "ODOO"];
const EXCLUDE: Partial<Record<MatchField, MatchSource[]>> = { ticket_id: ["ODOO"], job_type: ["ODOO"] };

function norm(field: MatchField, v: string): string {
  const s = v.trim();
  if (field === "barcode") return canonicalize(s);
  if (field === "date") return s.slice(0, 10);
  // Letters and digits only, case-folded: "MEENAL ATRI" = "Meenal Atri",
  // "ON-RET-DEL-13965" = "ONRETDEL13965" (Odoo's list view drops the hyphens).
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function fieldMatch(bySource: Record<MatchSource, MatchRow[]>, field: MatchField): FieldMatch {
  const compared = SOURCES.filter((s) => !(EXCLUDE[field] ?? []).includes(s));
  const holders: { source: MatchSource; value: string }[] = [];
  const keys = new Set<string>();
  for (const s of compared) {
    for (const r of bySource[s] ?? []) {
      const raw = r[field];
      if (raw == null || String(raw).trim() === "" || String(raw).trim() === "—") continue;
      holders.push({ source: s, value: String(raw).trim() });
      keys.add(norm(field, String(raw)));
    }
  }
  if (holders.length === 0) return { state: "none", compared, holders };
  if (keys.size > 1) return { state: "differ", compared, holders };
  const holding = new Set(holders.map((h) => h.source));
  return { state: compared.every((s) => holding.has(s)) ? "all" : "partial", compared, holders };
}
