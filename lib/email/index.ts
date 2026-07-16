// Send orchestration for the reconciliation digest.
//
// Recipients come from DIGEST_RECIPIENTS (comma-separated); if unset, the digest
// goes back to GMAIL_USER (ops@cityfurnish.com) so a fresh setup still delivers
// somewhere sensible. Sending never throws into the caller — a mail failure must
// not fail the reconcile run — callers get a typed result instead.

import { getSmtpConfig, getTransport, isEmailConfigured } from "./transport";
import {
  digestSubject,
  renderDigestHtml,
  renderDigestText,
  type DigestData,
} from "./digest";

export { isEmailConfigured } from "./transport";
export {
  buildDigestFromRun,
  buildDigestFromDb,
  type DigestData,
} from "./digest";

export interface SendResult {
  sent: boolean;
  skipped?: string; // reason, when not configured
  error?: string;
  recipients: string[];
  messageId?: string;
}

export function digestRecipients(): string[] {
  const raw = process.env.DIGEST_RECIPIENTS?.trim();
  if (raw) {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const fallback = process.env.GMAIL_USER?.trim();
  return fallback ? [fallback] : [];
}

function dashboardUrl(): string | undefined {
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (explicit) return `${explicit.replace(/\/$/, "")}/dashboard`;
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel}/dashboard`;
  return undefined;
}

export async function sendReconciliationDigest(
  data: DigestData,
  overrideRecipients?: string[]
): Promise<SendResult> {
  const recipients = overrideRecipients?.length
    ? overrideRecipients
    : digestRecipients();

  if (!isEmailConfigured()) {
    return { sent: false, skipped: "email not configured (GMAIL_USER / GMAIL_APP_PASSWORD)", recipients };
  }
  if (recipients.length === 0) {
    return { sent: false, skipped: "no recipients (set DIGEST_RECIPIENTS)", recipients };
  }

  const transport = getTransport();
  const cfg = getSmtpConfig();
  if (!transport || !cfg) {
    return { sent: false, skipped: "transport unavailable", recipients };
  }

  try {
    const info = await transport.sendMail({
      from: `Cityfurnish Ops <${cfg.user}>`,
      to: recipients.join(", "),
      subject: digestSubject(data),
      text: renderDigestText(data),
      html: renderDigestHtml(data, dashboardUrl()),
    });
    return { sent: true, recipients, messageId: info.messageId };
  } catch (err) {
    return {
      sent: false,
      error: err instanceof Error ? err.message : String(err),
      recipients,
    };
  }
}
