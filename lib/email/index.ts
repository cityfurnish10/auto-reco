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

export interface SendOptions {
  to?: string[]; // override 'to'; empty/undefined = DIGEST_RECIPIENTS
  cc?: string[];
  bcc?: string[];
  notes?: string; // admin note rendered into the email body
}

export interface SendResult {
  sent: boolean;
  skipped?: string; // reason, when not configured
  error?: string;
  recipients: string[]; // the 'to' list
  cc?: string[];
  bcc?: string[];
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
  opts: SendOptions = {}
): Promise<SendResult> {
  const recipients = opts.to?.length ? opts.to : digestRecipients();
  const cc = opts.cc ?? [];
  const bcc = opts.bcc ?? [];

  if (!isEmailConfigured()) {
    return { sent: false, skipped: "email not configured (GMAIL_USER / GMAIL_APP_PASSWORD)", recipients, cc, bcc };
  }
  if (recipients.length === 0) {
    return { sent: false, skipped: "no recipients (set DIGEST_RECIPIENTS)", recipients, cc, bcc };
  }

  const transport = getTransport();
  const cfg = getSmtpConfig();
  if (!transport || !cfg) {
    return { sent: false, skipped: "transport unavailable", recipients, cc, bcc };
  }

  try {
    const info = await transport.sendMail({
      from: `Cityfurnish Ops <${cfg.user}>`,
      to: recipients.join(", "),
      cc: cc.length ? cc.join(", ") : undefined,
      bcc: bcc.length ? bcc.join(", ") : undefined,
      subject: digestSubject(data),
      text: renderDigestText(data, opts.notes),
      html: renderDigestHtml(data, dashboardUrl(), opts.notes),
    });
    return { sent: true, recipients, cc, bcc, messageId: info.messageId };
  } catch (err) {
    return {
      sent: false,
      error: err instanceof Error ? err.message : String(err),
      recipients,
      cc,
      bcc,
    };
  }
}
