// Connector orchestrator. Runs all 4 source connectors concurrently (tolerant
// of individual failures), times each, and returns both the per-connector
// results (for ingestion_logs) and the merged Record<City, SourceRow[]> that
// runAllCities() consumes.

import { CITIES, type City } from "../sample-data";
import type { ReportedSources, SourceKind, SourceRow } from "../engine/types";
import type { Connector, ConnectorResult, CityTaggedRow } from "./types";
import { dtConnector } from "./dt";
import { odooConnector } from "./odoo";
import { sheetsConnector } from "./sheets";
import { guardConnector } from "./guard";

export const CONNECTORS: Connector[] = [
  guardConnector, // PHYSICAL
  sheetsConnector, // SHEET
  dtConnector, // DT
  odooConnector, // ODOO
];

export interface PullAllResult {
  rowsByCity: Record<City, SourceRow[]>;
  results: ConnectorResult[];
  presentSources: number; // how many of the 4 returned OK
  // Per city: which sources actually reported (connector OK AND ≥1 row for
  // the city). Feeds the engine's reported-aware ladder so a source outage or
  // a not-yet-filled ops sheet reads as "source down", not as a flood of
  // false "missing in X" variances.
  reportedByCity: Record<City, ReportedSources>;
}

async function runOne(
  c: Connector,
  runDate: string,
  incompleteByCity: Map<City, Set<SourceKind>>
): Promise<ConnectorResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const warnings: string[] = [];
  const ctx = {
    warn: (message: string) => warnings.push(`${c.label}: ${message}`),
    incomplete: (city: City) => {
      const set = incompleteByCity.get(city) ?? new Set<SourceKind>();
      set.add(c.source);
      incompleteByCity.set(city, set);
    },
  };
  try {
    const rows = await c.pull(runDate, ctx);
    return {
      source: c.source,
      label: c.label,
      ok: true,
      rows,
      rowsPulled: rows.length,
      warnings,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      source: c.source,
      label: c.label,
      ok: false,
      rows: [],
      rowsPulled: 0,
      message: err instanceof Error ? err.message : String(err),
      warnings,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
    };
  }
}

const FLAG: Record<SourceKind, keyof ReportedSources> = {
  PHYSICAL: "P",
  SHEET: "S",
  DT: "D",
  ODOO: "O",
};

/**
 * Which sources actually reported, per city.
 *
 * Reported = the connector succeeded AND returned ≥1 row for that city AND did
 * not raise the city as incomplete. That last clause is the one with teeth: a
 * partial answer is not an answer. A source that lost one of a city's two tabs
 * still returns rows for the other and would otherwise read as fully reported —
 * the exact shape that turns "we could not read it" into a confident zero in
 * the digest and a flood of false absences in the ladder.
 */
export function deriveReportedByCity(
  results: ConnectorResult[],
  incompleteByCity: ReadonlyMap<City, ReadonlySet<SourceKind>>
): Record<City, ReportedSources> {
  return Object.fromEntries(
    CITIES.map((city) => {
      const rep: ReportedSources = { P: false, S: false, D: false, O: false };
      const incomplete = incompleteByCity.get(city);
      for (const r of results) {
        if (!r.ok) continue;
        if (incomplete?.has(r.source)) continue;
        if (r.rows.some((row) => (row as CityTaggedRow).city === city)) {
          rep[FLAG[r.source]] = true;
        }
      }
      return [city, rep];
    })
  ) as Record<City, ReportedSources>;
}

export async function pullAll(runDate: string): Promise<PullAllResult> {
  // Filled by any connector that reached a city but could not read all of it.
  const incompleteByCity = new Map<City, Set<SourceKind>>();
  const results = await Promise.all(
    CONNECTORS.map((c) => runOne(c, runDate, incompleteByCity))
  );

  const rowsByCity = Object.fromEntries(
    CITIES.map((city) => [city, [] as SourceRow[]])
  ) as Record<City, SourceRow[]>;

  for (const r of results) {
    for (const row of r.rows) {
      const { city, ...sourceRow } = row as CityTaggedRow;
      rowsByCity[city].push(sourceRow);
    }
  }

  const reportedByCity = deriveReportedByCity(results, incompleteByCity);

  return {
    rowsByCity,
    results,
    presentSources: results.filter((r) => r.ok).length,
    reportedByCity,
  };
}
