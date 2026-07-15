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
  data?: { cols: Array<{ name: string }>; rows: unknown[][] };
  error?: string;
}

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
export async function runNativeSql(databaseId: number, sql: string): Promise<MetabaseTable> {
  const doRequest = async (): Promise<Response> =>
    fetch(`${baseUrl()}${DATASET_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({ database: databaseId, type: "native", native: { query: sql } }),
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
  return toTable(json);
}
