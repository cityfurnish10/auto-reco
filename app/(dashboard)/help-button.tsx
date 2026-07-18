"use client";

// Per-page help. A "?" button in the header that opens a short popover
// explaining what the current page does and how to use it. Content is keyed by
// route (the dashboard entry is role-aware).

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/icon";

type Help = { title: string; blurb: string; points: string[] };

const HELP: Record<string, Help> = {
  "/uploads": {
    title: "Guard Register Upload",
    blurb:
      "Upload the day's handwritten IN/OUT gate register (PDF). It is OCR'd immediately and its rows become the PHYSICAL source for reconciliation.",
    points: [
      "Choose the city and drop the scanned register PDF — OCR runs within seconds and stores each barcode, ticket, SO number, and direction.",
      "A clean scan matters: write barcodes and tickets one digit per box, and keep INWARD and OUTWARD on their labelled pages.",
      "Each PDF is also mirrored to the city's Google Drive folder for record-keeping.",
      "The nightly reconcile then matches these rows against the ops sheet, Delivery Tracker, and Odoo.",
    ],
  },
  "/leaderboard": {
    title: "City Leaderboard",
    blurb:
      "Ranks the five warehouses by reconciliation accuracy — how few REAL variances they have relative to total movements.",
    points: [
      "Accuracy = 1 − REAL variances / movements, measured as found in each run.",
      "Switch between the latest run, last 7 days, last 30 days, and overall.",
      "A higher rank means cleaner cross-source agreement — fewer gaps to chase.",
    ],
  },
  "/users": {
    title: "User Management",
    blurb:
      "Create and manage who can sign in — admins (all cities) and city managers (a single warehouse).",
    points: [
      "Add a user with a role, a city for managers, and a temporary password.",
      "A manager only ever sees and acts on their own city's data (enforced by row-level security).",
      "Deactivate a user to revoke access without losing their history.",
    ],
  },
  "/system-health": {
    title: "System Health",
    blurb:
      "The operational timeline — when registers were uploaded, when each reconcile ran, and when digests were emailed.",
    points: [
      "Confirms the nightly pipeline fired end to end: OCR → reconcile → email.",
      "Shows connector status per run (guard, sheet, Delivery Tracker, Odoo) and any warnings.",
      "Use it to spot a missed upload, a failed source pull, or a digest that didn't send.",
    ],
  },
  "/analytics": {
    title: "Analytics",
    blurb:
      "Trends over time — daily accuracy and variance volumes per city, drawn from every stored run.",
    points: [
      "Bar and line charts of accuracy across the last 7 and 30 days.",
      "Compare cities and spot which warehouses are improving or slipping.",
      "Complements the leaderboard's point-in-time ranking with the longer trend.",
    ],
  },
  "/email-digest": {
    title: "Email Digest",
    blurb:
      "Compose, preview, and send the daily reconciliation digest — the same report that goes out automatically each morning.",
    points: [
      "Pick recipients (To / Cc / Bcc) from your team and add an optional note that appears in the email.",
      "Send Now, or Schedule it to go out 1–3 days later — optionally only once all REAL variances are closed.",
      "The preview is the exact email that will be delivered.",
    ],
  },
};

const DASHBOARD_ADMIN: Help = {
  title: "Reconciliation Dashboard",
  blurb:
    "Every barcode from the latest run, compared across all four sources — the guard register, ops sheet, Delivery Tracker, and Odoo.",
  points: [
    "REAL = genuine cross-source gaps to chase today. INFO = posting-lag or data-hygiene noise, no action needed.",
    "Filter by city tab, bucket, source, priority, status, or date; search any barcode / ticket / SO number.",
    "Approve or Reject the variances city managers submit — the bell shows how many are awaiting you.",
    "Export the current view to CSV.",
  ],
};

const DASHBOARD_MANAGER: Help = {
  title: "Your Warehouse Dashboard",
  blurb:
    "Reconciliation variances for your city from the latest run — where the guard register, ops sheet, Delivery Tracker, and Odoo disagree about a barcode.",
  points: [
    "Focus on REAL variances — genuine gaps to investigate. INFO rows are posting-lag / hygiene, no action.",
    "Resolved one? Submit it for Approval with a reason; an admin reviews and closes it.",
    "A rejected item returns as Open with the admin's note — fix it and resubmit.",
    "Filter, search, and export your city's variances to CSV.",
  ],
};

const FALLBACK: Help = {
  title: "Reconciliation Portal",
  blurb:
    "The Cityfurnish warehouse auto-reconciliation portal — it cross-checks every barcode movement across the guard register, ops sheet, Delivery Tracker, and Odoo.",
  points: [
    "Use the left navigation to move between the dashboard, uploads, leaderboard, and reports.",
    "Each page has its own help — open this button anywhere for a quick explanation.",
  ],
};

function getHelp(pathname: string, role: "ADMIN" | "MANAGER"): Help {
  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) {
    return role === "ADMIN" ? DASHBOARD_ADMIN : DASHBOARD_MANAGER;
  }
  for (const key of Object.keys(HELP)) {
    if (pathname === key || pathname.startsWith(`${key}/`)) return HELP[key];
  }
  return FALLBACK;
}

export default function HelpButton({ role }: { role: "ADMIN" | "MANAGER" }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const help = getHelp(pathname, role);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="btn-icon"
        title="About this page"
        aria-label="About this page"
        aria-expanded={open}
      >
        <Icon name="help" size={20} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 mt-2 w-[320px] sm:w-[360px] card shadow-card-hover z-50 p-4 text-left">
            <div className="flex items-start justify-between gap-2 mb-1.5">
              <h3 className="font-headline text-base text-text-primary">{help.title}</h3>
              <button onClick={() => setOpen(false)} className="btn-icon -mr-1 -mt-1" aria-label="Close">
                <Icon name="close" size={16} />
              </button>
            </div>
            <p className="text-sm text-text-secondary mb-3">{help.blurb}</p>
            <ul className="space-y-1.5">
              {help.points.map((p) => (
                <li key={p} className="flex gap-2 text-xs text-text-muted">
                  <Icon name="check" size={14} className="text-accent mt-0.5 shrink-0" />
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
