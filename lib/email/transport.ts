// Gmail SMTP transport (Path B — app password, no service account).
//
// Set in the environment (never in code):
//   GMAIL_USER          e.g. ops@cityfurnish.com  (the mailbox mail is sent AS)
//   GMAIL_APP_PASSWORD  16-char app password from myaccount.google.com/apppasswords
//                       (requires 2-Step Verification on that account)
//
// Gmail shows the app password grouped as "abcd efgh ijkl mnop" — we strip the
// spaces so a copy-paste with spaces still authenticates.

import nodemailer, { type Transporter } from "nodemailer";

export interface SmtpConfig {
  user: string;
  pass: string;
}

export function getSmtpConfig(): SmtpConfig | null {
  const user = process.env.GMAIL_USER?.trim();
  const pass = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "");
  if (!user || !pass) return null;
  return { user, pass };
}

export function isEmailConfigured(): boolean {
  return getSmtpConfig() !== null;
}

let cached: Transporter | null = null;

export function getTransport(): Transporter | null {
  const cfg = getSmtpConfig();
  if (!cfg) return null;
  if (cached) return cached;
  cached = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true, // implicit TLS
    auth: { user: cfg.user, pass: cfg.pass },
  });
  return cached;
}
