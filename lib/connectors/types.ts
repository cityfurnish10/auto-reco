// Shared connector contract. Each connector pulls from one source and returns
// city-tagged rows in the engine's SourceRow shape. The orchestrator (index.ts)
// groups them into Record<City, SourceRow[]> for runAllCities(), and records an
// ingestion_logs row per connector.

import type { City } from "../sample-data";
import type { SourceKind, SourceRow } from "../engine/types";

// SourceRow has no city field (the engine groups externally), so connectors
// attach it here for the orchestrator to bucket by.
export interface CityTaggedRow extends SourceRow {
  city: City;
}

export interface Connector {
  source: SourceKind; // PHYSICAL | SHEET | DT | ODOO
  label: string; // human label for logs / System Health
  // Throws on failure — the orchestrator catches and logs it as FAILED.
  pull(runDate: string): Promise<CityTaggedRow[]>;
}

// Per-connector outcome the orchestrator records.
export interface ConnectorResult {
  source: SourceKind;
  label: string;
  ok: boolean;
  rows: CityTaggedRow[];
  rowsPulled: number;
  message?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

// Map arbitrary source city strings to the engine's City union.
// Per DB MODEL.md §20/§23c — the canonical cross-source city map. Keep this
// the single source of truth; when a source's spelling changes, update here.
const CITY_ALIASES: Record<string, City> = {
  delhi: "DELHI",
  "new delhi": "DELHI",
  ncr: "DELHI",
  gurgaon: "DELHI",
  gurugram: "DELHI",
  noida: "DELHI",
  mumbai: "MUMBAI",
  bombay: "MUMBAI",
  pune: "PUNE",
  hyderabad: "HYDRABAD",
  hydrabad: "HYDRABAD",
  hyd: "HYDRABAD",
  bangalore: "BANGALORE",
  bengaluru: "BANGALORE",
};

export function normalizeCity(raw: unknown): City | null {
  if (!raw) return null;
  return CITY_ALIASES[String(raw).trim().toLowerCase()] ?? null;
}
