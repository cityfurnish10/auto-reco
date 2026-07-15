// Odoo warehouse-code → engine City normalisation (DB MODEL.md §8). Never pass
// a raw warehouse code to the engine — unknown codes are logged and skipped
// by the connector.

import type { City } from "../sample-data";

const WAREHOUSE_TO_CITY: Record<string, City> = {
  BAN: "BANGALORE",
  GUR: "DELHI", // engine uses DELHI, not GUR, for the Gurugram/NCR bucket
  PUN: "PUNE",
  MUM: "MUMBAI",
  HYD: "HYDRABAD", // engine's legacy spelling
};

export function normalizeOdooWarehouse(code: unknown): City | null {
  if (!code) return null;
  return WAREHOUSE_TO_CITY[String(code).trim().toUpperCase()] ?? null;
}
