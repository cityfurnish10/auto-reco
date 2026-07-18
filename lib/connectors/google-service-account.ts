// Shared Google service-account credential reader. Used by the Sheets connector
// (read the movement registers) and the Drive mirror (push guard PDFs). Both
// authenticate as the same service account via GOOGLE_SERVICE_ACCOUNT_KEY — the
// JSON key pasted raw or base64-encoded as a single env line.

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

export function readServiceAccountKey(): ServiceAccountKey | null {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) return null;
  const trimmed = raw.trim();
  const jsonStr = trimmed.startsWith("{") ? trimmed : Buffer.from(trimmed, "base64").toString("utf-8");
  try {
    const parsed = JSON.parse(jsonStr) as Partial<ServiceAccountKey>;
    if (!parsed.client_email || !parsed.private_key) return null;
    // Defensive: some env-var paths flatten real newlines in private_key to
    // literal "\n" pairs a second time (common gotcha with this credential
    // shape) — restore them if JSON.parse didn't already.
    return {
      client_email: parsed.client_email,
      private_key: parsed.private_key.replace(/\\n/g, "\n"),
    };
  } catch {
    return null;
  }
}
