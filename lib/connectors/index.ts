// Connector orchestrator. Runs all 4 source connectors concurrently (tolerant
// of individual failures), times each, and returns both the per-connector
// results (for ingestion_logs) and the merged Record<City, SourceRow[]> that
// runAllCities() consumes.

import { CITIES, type City } from "../sample-data";
import type { SourceRow } from "../engine/types";
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
}

async function runOne(c: Connector, runDate: string): Promise<ConnectorResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  try {
    const rows = await c.pull(runDate);
    return {
      source: c.source,
      label: c.label,
      ok: true,
      rows,
      rowsPulled: rows.length,
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
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
    };
  }
}

export async function pullAll(runDate: string): Promise<PullAllResult> {
  const results = await Promise.all(CONNECTORS.map((c) => runOne(c, runDate)));

  const rowsByCity = Object.fromEntries(
    CITIES.map((city) => [city, [] as SourceRow[]])
  ) as Record<City, SourceRow[]>;

  for (const r of results) {
    for (const row of r.rows) {
      const { city, ...sourceRow } = row as CityTaggedRow;
      rowsByCity[city].push(sourceRow);
    }
  }

  return {
    rowsByCity,
    results,
    presentSources: results.filter((r) => r.ok).length,
  };
}
