// Shared Google service-account credential reader. Used by the Sheets connector
// (read the movement registers) and the Drive mirror (push guard PDFs). Both
// authenticate as the same service account via GOOGLE_SERVICE_ACCOUNT_KEY — the
// JSON key pasted raw or base64-encoded as a single env line.

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

/**
 * JSON.parse for an env var, tolerating the backslash-escaped form that some
 * env editors and shells store.
 *
 * Measured 2026-07-30: SHEETS_CONFIG was held as `{\"DELHI\":{...}}` — fine to
 * paste, impossible to parse. readSheetsConfig() swallowed the SyntaxError and
 * returned null, the connector reported "Sheets not configured", and the ops
 * sheet went unread on every run from 27 Jul while the other three sources kept
 * succeeding. The register PDFs are built from those rows, so they silently
 * stopped being attached to the digest at the same time.
 *
 * The unescape runs ONLY when a plain parse fails and the string opens with an
 * escaped quote, so a payload whose own values legitimately contain \" is never
 * rewritten.
 */
export function parseJsonEnv<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    /* fall through and try the escaped form */
  }
  if (!/^\s*[[{]\s*\\"/.test(raw)) return null;
  try {
    return JSON.parse(raw.replace(/\\"/g, '"')) as T;
  } catch {
    return null;
  }
}

export function readServiceAccountKey(): ServiceAccountKey | null {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) return null;
  const trimmed = raw.trim();
  const jsonStr = trimmed.startsWith("{") ? trimmed : Buffer.from(trimmed, "base64").toString("utf-8");
  const parsed = parseJsonEnv<Partial<ServiceAccountKey>>(jsonStr);
  if (!parsed?.client_email || !parsed.private_key) return null;
  // Defensive: some env-var paths flatten real newlines in private_key to
  // literal "\n" pairs a second time (common gotcha with this credential
  // shape) — restore them if JSON.parse didn't already.
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key.replace(/\\n/g, "\n"),
  };
}
