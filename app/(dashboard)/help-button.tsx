"use client";

// Per-page help. A "?" button in the header that opens a short popover
// explaining what the current page does and how to use it. Content is keyed by
// route (the dashboard entry is role-aware).

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/icon";

// Content lives in lib/help/portal-help.ts so the chat assistant can serve the
// same answers — a "use client" module cannot be imported by a route handler,
// and the assistant must describe the portal from this text rather than from
// its own guess at how the portal works.
import {
  DASHBOARD_ADMIN,
  DASHBOARD_MANAGER,
  HELP_BY_ROUTE as HELP,
  type HelpEntry as Help,
} from "@/lib/help/portal-help";


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
