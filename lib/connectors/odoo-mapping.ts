// Odoo warehouse-code → engine City normalisation (DB MODEL.md §8). Never pass
// a raw warehouse code to the engine — unknown codes are logged and skipped
// by the connector.

import type { City } from "../sample-data";

// Live Odoo has 8 warehouse codes (BAN, GGN, GUR, HYD, JDH, MUM, NOI, PUN).
// Only 5 carry active movements (BAN/GUR/HYD/MUM/PUN → the 5 reco cities).
// GGN (Gurgaon) and NOI (Noida) are NCR and fold into the DELHI bucket like
// the DT connector already does (gurgaon/noida → DELHI); currently dormant but
// mapped defensively so a row is never silently dropped if they reactivate.
// JDH (Jodhpur) is intentionally unmapped — not a reconciliation city, so its
// rows are skipped (normalizeOdooWarehouse returns null → connector skips).
const WAREHOUSE_TO_CITY: Record<string, City> = {
  BAN: "BANGALORE",
  GUR: "DELHI", // engine uses DELHI, not GUR, for the Gurugram/NCR bucket
  GGN: "DELHI", // Gurgaon (NCR)
  NOI: "DELHI", // Noida (NCR)
  PUN: "PUNE",
  MUM: "MUMBAI",
  HYD: "HYDERABAD", // engine's legacy spelling
};

export function normalizeOdooWarehouse(code: unknown): City | null {
  if (!code) return null;
  return WAREHOUSE_TO_CITY[String(code).trim().toUpperCase()] ?? null;
}
