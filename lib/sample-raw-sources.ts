// SAMPLE barcode-level source feeds for the demo "Run Reconciliation" flow —
// the stand-in for the Phase 2 connectors (Physical gate register, Ops sheet,
// Delivery Tracker, Odoo). Each city's scenario is hand-built to exercise a
// spread of the variance ladder + suppressions so the engine output is
// visibly meaningful. Replaced by real connector pulls in Phase 2.

import { CITIES, type City } from "./sample-data";
import type { SourceRow } from "./engine/types";

type Row = Omit<SourceRow, "date" | "createdOn"> & {
  date?: string;
  createdOn?: string;
};

// Given a run date, build a realistic-ish set of rows per city. Deviations
// increase down the demo accuracy ladder (BANGALORE cleanest … HYDERABAD worst).
function scenarioFor(city: City, runDate: string, nextDay: string): SourceRow[] {
  const rows: SourceRow[] = [];
  const push = (r: Row) =>
    rows.push({ ...r, date: r.date ?? runDate } as SourceRow);

  // Reconciled baseline: N items present + done in all four sources, OUT.
  const reconciledCount =
    city === "BANGALORE" ? 14 : city === "MUMBAI" ? 12 : city === "PUNE" ? 11 : city === "DELHI" ? 10 : 9;
  for (let i = 1; i <= reconciledCount; i++) {
    const code = `${city.slice(0, 3)}-OK-${String(i).padStart(3, "0")}`;
    const so = `SO-${city.slice(0, 3)}-${1000 + i}`;
    const common = { soNumber: so, customer: `Cust ${i}`, product: `Sofa Model ${i}` };
    push({ source: "PHYSICAL", direction: "OUT", barcode: code, status: "done", ...common });
    push({ source: "SHEET", direction: "OUT", barcode: code, status: "done", ...common });
    push({ source: "DT", direction: "OUT", barcode: code, status: "done", ...common });
    push({ source: "ODOO", direction: "OUT", barcode: code, status: "done", jobType: "NEW_RENTAL", createdOn: city === "DELHI" ? nextDay : runDate, ...common });
  }

  // ── Seeded REAL variances ────────────────────────────────────────────
  // Odoo-Only Entry — No Floor Record (OUT).
  push({ source: "ODOO", direction: "OUT", barcode: `${city.slice(0, 3)}-ODOOONLY-1`, status: "done", jobType: "NEW_RENTAL", createdOn: city === "DELHI" ? nextDay : runDate, soNumber: `SO-${city.slice(0, 3)}-9001`, product: "Bed King" });

  // Gate-Only Dispatch — No Ops/Odoo Trail (OUT).
  push({ source: "PHYSICAL", direction: "OUT", barcode: `${city.slice(0, 3)}-GATEONLY-1`, status: "done", soNumber: `SO-${city.slice(0, 3)}-9002`, product: "Wardrobe 3D" });

  // Register/DT Logged — Not in Odoo (P+S+D, no O) (OUT).
  const rdl = `${city.slice(0, 3)}-NOODOO-1`;
  push({ source: "PHYSICAL", direction: "OUT", barcode: rdl, status: "done", soNumber: `SO-${city.slice(0, 3)}-9003`, product: "Dining Set" });
  push({ source: "SHEET", direction: "OUT", barcode: rdl, status: "done", soNumber: `SO-${city.slice(0, 3)}-9003`, product: "Dining Set" });
  push({ source: "DT", direction: "OUT", barcode: rdl, status: "done", soNumber: `SO-${city.slice(0, 3)}-9003`, product: "Dining Set" });

  // Extra REAL variances for the weaker cities.
  if (city === "DELHI" || city === "HYDERABAD") {
    // Sheet-Only Dispatch — No Trail (OUT).
    push({ source: "SHEET", direction: "OUT", barcode: `${city.slice(0, 3)}-SHEETONLY-1`, status: "done", soNumber: `SO-${city.slice(0, 3)}-9004`, product: "Study Table" });
  }
  if (city === "HYDERABAD") {
    // Fake Scan Risk — DT status non_match.
    push({ source: "PHYSICAL", direction: "OUT", barcode: `HYD-FAKE-1`, status: "done", soNumber: "SO-HYD-9005", product: "Office Chair" });
    push({ source: "DT", direction: "OUT", barcode: "HYD-FAKE-1", status: "non_match", soNumber: "SO-HYD-9005", product: "Office Chair" });
  }

  // ── Seeded INFO variances ────────────────────────────────────────────
  // Odoo Update Pending — Movement Confirmed (P+S+O, no D) (OUT).
  const oup = `${city.slice(0, 3)}-DTLAG-1`;
  push({ source: "PHYSICAL", direction: "OUT", barcode: oup, status: "done", soNumber: `SO-${city.slice(0, 3)}-9010`, product: "TV Unit" });
  push({ source: "SHEET", direction: "OUT", barcode: oup, status: "done", soNumber: `SO-${city.slice(0, 3)}-9010`, product: "TV Unit" });
  push({ source: "ODOO", direction: "OUT", barcode: oup, status: "done", jobType: "NEW_RENTAL", createdOn: city === "DELHI" ? nextDay : runDate, soNumber: `SO-${city.slice(0, 3)}-9010`, product: "TV Unit" });

  // Duplicate Scan (same barcode twice in physical) (OUT).
  const dup = `${city.slice(0, 3)}-DUP-1`;
  push({ source: "PHYSICAL", direction: "OUT", barcode: dup, status: "done", soNumber: `SO-${city.slice(0, 3)}-9011`, product: "Mattress" });
  push({ source: "PHYSICAL", direction: "OUT", barcode: dup, status: "done", soNumber: `SO-${city.slice(0, 3)}-9011`, product: "Mattress" });
  push({ source: "SHEET", direction: "OUT", barcode: dup, status: "done", soNumber: `SO-${city.slice(0, 3)}-9011`, product: "Mattress" });
  push({ source: "DT", direction: "OUT", barcode: dup, status: "done", soNumber: `SO-${city.slice(0, 3)}-9011`, product: "Mattress" });
  push({ source: "ODOO", direction: "OUT", barcode: dup, status: "done", jobType: "NEW_RENTAL", createdOn: city === "DELHI" ? nextDay : runDate, soNumber: `SO-${city.slice(0, 3)}-9011`, product: "Mattress" });

  // Spare/Consumable Movement (INFO) (OUT).
  push({ source: "PHYSICAL", direction: "OUT", barcode: "SPARE-BOLT-KIT", status: "done", product: "Spare" });

  // ── Seeded SUPPRESSIONS (should NOT appear as variances) ──────────────
  // DT All-Pending — every DT entry pending → suppress all (OUT).
  const allPend = `${city.slice(0, 3)}-ALLPEND-1`;
  push({ source: "PHYSICAL", direction: "OUT", barcode: allPend, status: "done", soNumber: `SO-${city.slice(0, 3)}-9020`, product: "Recliner" });
  push({ source: "DT", direction: "OUT", barcode: allPend, status: "pending", soNumber: `SO-${city.slice(0, 3)}-9020`, product: "Recliner" });
  push({ source: "DT", direction: "OUT", barcode: allPend, status: "pending", soNumber: `SO-${city.slice(0, 3)}-9020`, product: "Recliner" });

  // Internal Repair Movement — Odoo REPAIR, no ticket/customer/SO → suppress (OUT).
  push({ source: "ODOO", direction: "OUT", barcode: `${city.slice(0, 3)}-REPAIR-1`, status: "done", jobType: "REPAIR", createdOn: city === "DELHI" ? nextDay : runDate });

  // Direction Conflict — same SO both IN and OUT, OUT completed → fires.
  const conflict = `${city.slice(0, 3)}-CONFLICT-1`;
  const conflictSo = `SO-${city.slice(0, 3)}-9030`;
  push({ source: "PHYSICAL", direction: "OUT", barcode: conflict, status: "done", soNumber: conflictSo, product: "Sofa Recliner", customer: "Repeat Cust" });
  push({ source: "DT", direction: "OUT", barcode: conflict, status: "done", soNumber: conflictSo, product: "Sofa Recliner", customer: "Repeat Cust" });
  push({ source: "PHYSICAL", direction: "IN", barcode: conflict, status: "done", soNumber: conflictSo, product: "Sofa Recliner", customer: "Repeat Cust" });
  push({ source: "SHEET", direction: "IN", barcode: conflict, status: "done", soNumber: conflictSo, product: "Sofa Recliner", customer: "Repeat Cust" });

  return rows;
}

export function buildSampleRowsByCity(
  runDate: string
): Record<City, SourceRow[]> {
  const nextDay = new Date(Date.UTC(
    Number(runDate.slice(0, 4)),
    Number(runDate.slice(5, 7)) - 1,
    Number(runDate.slice(8, 10))
  ) + 86400000)
    .toISOString()
    .slice(0, 10);

  const out = {} as Record<City, SourceRow[]>;
  for (const city of CITIES) out[city] = scenarioFor(city, runDate, nextDay);
  return out;
}
