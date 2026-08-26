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
//
// A CITY HERE IS A WAREHOUSE, NOT A PLACE. There are five physical buildings,
// and each serves a catchment of smaller cities around it — a Chennai delivery
// physically leaves through the Bangalore gate, so for reconciliation it IS
// Bangalore. gate_sites.serves has recorded these catchments since 0026; this
// table did not, and the difference was silently expensive:
//
//   MEASURED 2026-08-26. DT carried 50 Chennai deliveries and one Hosur in a
//   single week. normalizeCity returned null for every one, and the DT
//   connector skips a row with no city — so fifty real movements through the
//   Bangalore gate were dropped before reconciliation ever saw them. The same
//   held for Ghaziabad, Faridabad, Navi Mumbai and Thane.
//
// The catchments below mirror gate_sites.serves exactly. If a warehouse starts
// serving somewhere new, both need updating — a mismatch is invisible and
// costs whole cities.
const CATCHMENTS: Record<City, string[]> = {
  // Jaipur is served from the Delhi building — confirmed by operations
  // 2026-08-26. It appeared in DT and was being dropped for want of a home.
  DELHI:     ["delhi", "new delhi", "ncr", "gurgaon", "gurugram", "noida",
              "ghaziabad", "faridabad", "jaipur"],
  MUMBAI:    ["mumbai", "bombay", "navi mumbai", "thane", "bhiwandi"],
  PUNE:      ["pune"],
  HYDERABAD: ["hyderabad", "hydrabad", "hyd", "secunderabad"],
  BANGALORE: ["bangalore", "bengaluru", "hosur", "chennai"],
};

const CITY_ALIASES: Record<string, City> = Object.fromEntries(
  Object.entries(CATCHMENTS).flatMap(([city, names]) =>
    names.map((n) => [n, city as City])
  )
);

/**
 * Which places a warehouse serves. Exported so the gate screens can say
 * "Bangalore (also Hosur, Chennai)" rather than implying a Chennai delivery
 * has wandered through the wrong gate.
 */
export const catchmentFor = (city: City): string[] => CATCHMENTS[city] ?? [];

export function normalizeCity(raw: unknown): City | null {
  if (!raw) return null;
  return CITY_ALIASES[String(raw).trim().toLowerCase()] ?? null;
}
