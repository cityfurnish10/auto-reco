// Minimal Metabase REST API client — the Odoo connector's transport (native
// SQL against the "Odoo Live Database" connection at analytics.rentofurniture.com;
// see DB MODEL.md §5/§6/§10). Auth is either an API key (preferred) or a
// username/password session.
//
// Not used by the DT connector — DT reads MongoDB directly (lib/connectors/dt.ts).

const DATASET_PATH = "/api/dataset";
const SESSION_PATH = "/api/session";

export function metabaseConfigured(): boolean {
  const hasAuth =
    !!process.env.METABASE_API_KEY ||
    !!(process.env.METABASE_USERNAME && process.env.METABASE_PASSWORD);
  return !!process.env.METABASE_URL && hasAuth;
}

function baseUrl(): string {
  const url = process.env.METABASE_URL;
  if (!url) throw new Error("METABASE_URL not set.");
  return url.replace(/\/+$/, "");
}

let sessionToken: string | null = null;

async function login(): Promise<string> {
  const username = process.env.METABASE_USERNAME;
  const password = process.env.METABASE_PASSWORD;
  if (!username || !password) {
    throw new Error(
      "Metabase session auth requires METABASE_USERNAME + METABASE_PASSWORD (or set METABASE_API_KEY instead)."
    );
  }
  const res = await fetch(`${baseUrl()}${SESSION_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    throw new Error(`Metabase login failed: HTTP ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { id: string };
  sessionToken = json.id;
  return sessionToken;
}

async function authHeaders(): Promise<Record<string, string>> {
  if (process.env.METABASE_API_KEY) {
    return { "x-api-key": process.env.METABASE_API_KEY };
  }
  if (!sessionToken) await login();
  return { "X-Metabase-Session": sessionToken! };
}

interface MetabaseDatasetResponse {
  data?: {
    cols: Array<{ name: string }>;
    rows: unknown[][];
    /**
     * Metabase's own "I cut your result short" flag. It was always in the
     * response and this interface simply did not declare it, so it was read by
     * nobody and the silent truncation below went unnoticed for months.
     */
    rows_truncated?: number | boolean;
  };
  error?: string;
}

/**
 * The row ceiling asked for on every native query.
 *
 * WHY THIS EXISTS AT ALL. /api/dataset silently caps a native result at 2,000
 * rows when the request carries no `constraints`, which is what this client sent
 * until 2026-08-11. It does not error, it does not warn — it returns 2,000 rows
 * and a `rows_truncated` flag nobody read.
 *
 * MEASURED, and it was not hypothetical — but the two measurements say
 * different things and are worth keeping apart.
 *
 * REPLAYED: the ±1 span, re-run against Odoo as it stands, exceeds 2,000 rows on
 * 12 of the 98 business days to 2026-08-09, peaking at 2,405 on 2026-07-20. That
 * is the exposure a re-run of those dates carries today.
 *
 * ACTUALLY LANDED: `ingestion_logs.rows_pulled` never exceeds 2000 and sits on
 * it exactly three times, all within 2026-07-23/24, next-highest 1,985. Fewer,
 * because a pull that fires before the forward day has finished posting has less
 * to truncate. Three silent losses is still three too many, and the re-check
 * sweep re-runs those dates at today's larger volume.
 *
 * WHICH ROWS IT ATE, and why that is the worst possible half. The query ends
 * `ORDER BY sml.date ASC`, so the cap keeps the OLDEST postings and discards the
 * newest. On 2026-07-20 the 405 lost rows were all dated 07-21 — the forward day
 * that POSTING_DAYS_AFTER exists to fetch. The window was being widened to catch
 * late postings and then the late postings were the ones thrown away.
 *
 * 100,000 is ~20x the worst window ever measured (4,990 rows at ±3 on
 * 2026-06-16), so it is headroom rather than a limit — and because the guard
 * below throws when the flag comes back set, crossing it is loud instead of
 * silent. Verified honoured against this instance at 100,000. Do not read the
 * ceiling as free: the cheap probes (200,000 rows of ONE column in ~1-2s) are
 * not the production shape, and 100,000 rows at the pull's 11 columns measured
 * ~3.2s with one 200,000 x 5-column run taking 139s. Nothing here should ever
 * approach that — if it does, the query is the bug, not the limit.
 *
 * `max-results-bare-rows` is the operative key for a SELECT with no aggregation
 * — measured, `max-results` alone still returns 2,000. Both are sent because
 * the aggregate path uses the other one.
 */
const RESULT_LIMIT = 100_000;

export interface MetabaseTable {
  columns: string[];
  rows: Record<string, unknown>[];
}

function toTable(json: MetabaseDatasetResponse): MetabaseTable {
  const columns = (json.data?.cols ?? []).map((c) => c.name);
  const rows = (json.data?.rows ?? []).map((r) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((c, i) => (obj[c] = r[i]));
    return obj;
  });
  return { columns, rows };
}

// Runs a native SQL query against a Postgres-backed Metabase database
// connection. One relogin-and-retry on 401 when using username/password auth
// (API-key auth doesn't expire mid-run, so no retry is attempted for it).
export async function runNativeSql(
  databaseId: number,
  sql: string,
  /**
   * Wall-clock ceiling for this query, in ms. Omitted means no timeout, which
   * is what every call did before and still does by default.
   *
   * Worth passing on any query the run can live without. Nothing else in
   * lib/connectors/ sets an AbortSignal, and the reconcile is a maxDuration=60
   * function whose cron passes measure around p50 40s / p90 50s (max 56.1s)
   * with half a dozen runs stranded at status='running' — the platform-kill
   * signature. A Metabase stall on an OPTIONAL query should cost that query,
   * not the night.
   */
  timeoutMs?: number
): Promise<MetabaseTable> {
  const doRequest = async (): Promise<Response> =>
    fetch(`${baseUrl()}${DATASET_PATH}`, {
      method: "POST",
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({
        database: databaseId,
        type: "native",
        native: { query: sql },
        constraints: {
          "max-results": RESULT_LIMIT,
          "max-results-bare-rows": RESULT_LIMIT,
        },
      }),
    });

  let res = await doRequest();
  if (res.status === 401 && !process.env.METABASE_API_KEY) {
    sessionToken = null; // force relogin
    res = await doRequest();
  }
  if (!res.ok) {
    throw new Error(`Metabase native query failed: HTTP ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as MetabaseDatasetResponse;
  if (json.error) throw new Error(`Metabase query error: ${json.error}`);
  // THROW, never warn — and be precise about what the throw buys, because it is
  // not "the run stops". A connector throw is caught in lib/connectors/index.ts
  // runOne, the pipeline continues with three sources, the run is marked
  // 'partial' and the digest still goes out.
  //
  // What changes is WHICH story the engine tells. A truncated pull returns rows,
  // so the city reads as REPORTED and every Odoo-blaming rung fires against
  // postings the pull happened to discard — a warehouse told to post entries it
  // already posted. A throw sets reported.O = false, which disables those rungs
  // outright. Silence about Odoo beats a confident accusation built on half of it.
  // One known false positive, left in deliberately: Metabase sets the flag when
  // the row count EQUALS the limit, even if nothing was actually dropped. At
  // 100,000 against a worst observed window of 2,405 (42x headroom) that cannot
  // happen without something else already being badly wrong, and failing loud is
  // the right answer in that case too.
  if (json.data?.rows_truncated) {
    throw new Error(
      `Metabase truncated the result at ${json.data.rows?.length ?? "?"} rows (limit ${RESULT_LIMIT}). ` +
        `Refusing to reconcile from a partial pull — the rows dropped are the NEWEST, which is exactly the late-posting evidence the window exists to fetch.`
    );
  }
  return toTable(json);
}
