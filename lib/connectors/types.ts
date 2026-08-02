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

/**
 * How a connector reports a problem that is NOT worth failing the whole source.
 *
 * WHY THIS EXISTS. A source is either up or down in this contract, and that has
 * exactly one gap: a source that answers for four cities and silently loses the
 * fifth. Measured 2026-08-02 — Pune's ops sheet lost the header row on its
 * Inward tab, so the connector could not find the Date and Barcode columns and
 * skipped all 16,578 rows with a bare `continue`. The pull still succeeded, the
 * other tab still returned rows, so PUNE read as REPORTED with a whole
 * direction missing: the digest would have printed 0 inward instead of "-", and
 * the ladder would have blamed the sheet for every inward unit it never saw.
 *
 * Throwing was not the alternative — one broken tab would take the ops sheet
 * down for all five cities. So: say it out loud, and demote just that city.
 */
export interface PullContext {
  /** A problem a human should see. Surfaced in the run's warnings. */
  warn(message: string): void;
  /**
   * This city's data came back INCOMPLETE. The orchestrator clears the source's
   * `reported` flag for that city, so the digest prints "-" rather than a
   * number that is missing a tab, and the reported-aware ladder stops treating
   * absence as evidence.
   */
  incomplete(city: City): void;
}

export interface Connector {
  source: SourceKind; // PHYSICAL | SHEET | DT | ODOO
  label: string; // human label for logs / System Health
  // Throws on failure — the orchestrator catches and logs it as FAILED.
  pull(runDate: string, ctx?: PullContext): Promise<CityTaggedRow[]>;
}

// Per-connector outcome the orchestrator records.
export interface ConnectorResult {
  source: SourceKind;
  label: string;
  ok: boolean;
  rows: CityTaggedRow[];
  rowsPulled: number;
  message?: string;
  /** Non-fatal problems raised through PullContext.warn during this pull. */
  warnings: string[];
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
  hyderabad: "HYDERABAD",
  hydrabad: "HYDERABAD",
  hyd: "HYDERABAD",
  bangalore: "BANGALORE",
  bengaluru: "BANGALORE",
};

export function normalizeCity(raw: unknown): City | null {
  if (!raw) return null;
  return CITY_ALIASES[String(raw).trim().toLowerCase()] ?? null;
}
