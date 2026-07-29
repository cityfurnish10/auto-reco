// Sending the follow-up. Mirrors sendReconciliationDigest: render once, reuse
// the same strings for the wire and the archive, never throw.

import { getSmtpConfig, getTransport, isEmailConfigured } from "../transport";
import { dashboardUrl } from "../index";
import { followUpSubject, renderFollowUpHtml, renderFollowUpText } from "./index";
import type { FollowUpComparison } from "./compare";
import type { FollowUpOpts } from "./sections";

export interface FollowUpSendResult {
  sent: boolean;
  skipped?: string;
  error?: string;
  recipients: string[];
  cc: string[];
  bcc: string[];
  messageId?: string;
  subject?: string;
  html?: string;
}

export async function sendFollowUpEmail(
  c: FollowUpComparison,
  opts: { to: string[]; cc?: string[]; bcc?: string[] } & FollowUpOpts
): Promise<FollowUpSendResult> {
  const recipients = opts.to.filter(Boolean);
  const cc = opts.cc ?? [];
  const bcc = opts.bcc ?? [];
  if (!isEmailConfigured()) {
    return { sent: false, skipped: "email not configured", recipients, cc, bcc };
  }
  if (recipients.length === 0) {
    return { sent: false, skipped: "no recipients", recipients, cc, bcc };
  }
  const transport = getTransport();
  const cfg = getSmtpConfig();
  if (!transport || !cfg) {
    return { sent: false, skipped: "transport unavailable", recipients, cc, bcc };
  }

  const render: FollowUpOpts = {
    dashboardUrl: dashboardUrl(),
    staleSince: opts.staleSince ?? null,
    restDayCities: opts.restDayCities,
  };
  const subject = followUpSubject(c);
  const html = renderFollowUpHtml(c, render);

  try {
    const info = await transport.sendMail({
      from: `Cityfurnish Ops <${cfg.user}>`,
      to: recipients.join(", "),
      cc: cc.length ? cc.join(", ") : undefined,
      bcc: bcc.length ? bcc.join(", ") : undefined,
      subject,
      text: renderFollowUpText(c, render),
      html,
      // No register PDFs. That register went out with the day's own digest three
      // days ago; re-sending it confuses rather than helps.
    });
    return { sent: true, recipients, cc, bcc, messageId: info.messageId, subject, html };
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
