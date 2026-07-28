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

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface SendOptions {
  to?: string[]; // override 'to'; empty/undefined = DIGEST_RECIPIENTS
  cc?: string[];
  bcc?: string[];
  notes?: string; // admin note rendered into the email body
  // Passed straight to nodemailer. Gmail's practical ceiling is ~25MB; the
  // register PDF for a full day is a few hundred KB.
  attachments?: EmailAttachment[];
  // Why no register is attached, when none is (see registerAttachments()).
  // Rendered as a muted footer line so a recipient expecting the register
  // learns it was pruned rather than assuming the email is broken.
  attachmentNote?: string;
}

export interface SendResult {
  sent: boolean;
  skipped?: string; // reason, when not configured
  error?: string;
  recipients: string[]; // the 'to' list
  cc?: string[];
  bcc?: string[];
  messageId?: string;
  // The exact rendered email, returned on success so callers can archive the
  // delivered content (see lib/email/email-archive.ts).
  subject?: string;
  html?: string;
  /** Attachments actually delivered, so callers can archive them. */
  attachments?: EmailAttachment[];
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

// The link recipients click — always the stable production domain, never
// VERCEL_URL (that is the per-deployment URL: deployment-protected, so email
// recipients would hit a 403/login wall). NEXT_PUBLIC_APP_URL still overrides
// for a future custom domain.
const PROD_APP_URL = "https://auto-reco.vercel.app";

// Exported so the preview route renders with the SAME link the real send uses
// (it previously kept its own stale copy of this logic and drifted).
export function dashboardUrl(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.trim() || PROD_APP_URL;
  return `${base.replace(/\/$/, "")}/dashboard`;
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

  // Render once — the same strings go to the wire and back to the caller for
  // archiving, so the archive is byte-identical to the delivered email.
  const subject = digestSubject(data);
  const html = renderDigestHtml(data, dashboardUrl(), opts.notes, opts.attachmentNote);

  try {
    const info = await transport.sendMail({
      from: `Cityfurnish Ops <${cfg.user}>`,
      to: recipients.join(", "),
      cc: cc.length ? cc.join(", ") : undefined,
      bcc: bcc.length ? bcc.join(", ") : undefined,
      subject,
      text: renderDigestText(data, opts.notes, opts.attachmentNote),
      html,
      attachments: opts.attachments?.length ? opts.attachments : undefined,
    });
    return {
      sent: true,
      recipients,
      cc,
      bcc,
      messageId: info.messageId,
      subject,
      html,
      attachments: opts.attachments,
    };
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
