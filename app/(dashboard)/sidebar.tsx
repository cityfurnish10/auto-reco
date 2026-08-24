"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getSupabaseClient } from "@/lib/supabase/client";
import { clearSessionCookie, type SessionUser } from "@/lib/demo-auth";
import { useDemoStore } from "@/lib/demo-store";
import { runAllCities } from "@/lib/engine/run";
import { buildSampleRowsByCity } from "@/lib/sample-raw-sources";
import { Icon, type IconName } from "@/components/icon";
import { useToast } from "@/components/toast";
import { istDate, reconcileTargetDate } from "@/lib/reconcile/cron-dates";

const supabaseConfigured =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
  !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const NAV_ITEMS: {
  href: string;
  label: string;
  icon: IconName;
  roles: string[];
}[] = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard", roles: ["ADMIN", "MANAGER"] },
  // Managers too — RLS scopes them to their own city, so no route gate needed
  // (and it must NOT go in middleware's ADMIN_ONLY_PATHS).
  { href: "/pending-list", label: "Pending List", icon: "pending_actions", roles: ["ADMIN", "MANAGER"] },
  // ONE entry, not five. The gate work wanted Activity, Guards, Devices and
  // Reviews as separate destinations; the sidebar was already at ten, and
  // fifteen is past the point anyone scans a list instead of hunting it. The
  // paper upload lives inside it too, so the pilot reads as one transition
  // rather than two competing screens.
  { href: "/gate", label: "Gate", icon: "shield", roles: ["ADMIN", "MANAGER"] },
  { href: "/leaderboard", label: "Leaderboard", icon: "leaderboard", roles: ["ADMIN", "MANAGER"] },
  { href: "/users", label: "User Management", icon: "group", roles: ["ADMIN"] },
  { href: "/system-health", label: "System Health", icon: "health_and_safety", roles: ["ADMIN"] },
  { href: "/analytics", label: "Analytics", icon: "monitoring", roles: ["ADMIN"] },
  // Straight after Analytics: the two are read together.
  { href: "/stock-analyser", label: "Stock Analyser", icon: "inventory_2", roles: ["ADMIN"] },
  { href: "/email-digest", label: "Email Digest", icon: "mail", roles: ["ADMIN"] },
];

export default function Sidebar({
  user,
  open = false,
  onClose,
}: {
  user: SessionUser;
  open?: boolean;
  onClose?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { applyReconciliationRun } = useDemoStore();
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const [runToast, setRunToast] = useState<{ ok: boolean; text: string } | null>(null);
  // Default to the same day the nightly job closes (yesterday) — today's books
  // are still being written, so reconciling today is rarely what's wanted.
  // Today stays selectable via the picker's max.
  const today = istDate();
  const [runDate, setRunDate] = useState(reconcileTargetDate); // date the run reconciles

  async function handleRunReconciliation() {
    if (running) return;

    // Real mode: trigger the actual server-side pipeline (POST /api/reconcile),
    // same as the nightly cron, then tell the dashboard to refetch.
    if (supabaseConfigured) {
      const ok = await toast.confirm({
        title: `Run reconciliation for ${runDate}?`,
        body: (
          <>
            <p>
              This pulls all four sources — guard register, ops sheet, DT and Odoo — and
              re-derives every variance for that day. It can take up to a minute.
            </p>
            <p className="text-text-muted">
              Existing variances are refreshed in place; anything already resolved or
              approved keeps its status.
            </p>
          </>
        ),
        confirmLabel: "Run now",
      });
      if (!ok) return;
      setRunning(true);
      try {
        const res = await fetch("/api/reconcile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ date: runDate }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json.ok === false) {
          throw new Error(json.error ?? `HTTP ${res.status}`);
        }
        const c = json.combined ?? {};
        setRunToast({
          ok: true,
          text: `Run ${json.runDate} · ${json.status} — ${c.real_count ?? 0} losses to chase, ${json.variancesUpserted ?? 0} variances stored (${c.info_count ?? 0} posting-lag hidden).`,
        });
        // Nudge any open dashboard to reload its data in place.
        window.dispatchEvent(new CustomEvent("reconcile:complete"));
      } catch (e) {
        setRunToast({
          ok: false,
          text: e instanceof Error ? e.message : String(e),
        });
      } finally {
        setRunning(false);
        // A failure stays until dismissed — auto-hiding an error the admin may
        // not have seen (the run takes up to a minute) is how a broken night
        // goes unnoticed.
        setTimeout(() => setRunToast((t) => (t?.ok ? null : t)), 8000);
      }
      return;
    }

    // Demo mode: engine runs client-side over sample raw feeds for the date.
    setRunning(true);
    setTimeout(() => {
      const run = runAllCities(buildSampleRowsByCity(runDate));
      applyReconciliationRun(run);
      setRunning(false);
      setRunToast({
        ok: true,
        text: `Run complete — ${run.combined.real_count} losses to chase across ${run.perCity.length} cities (${run.combined.info_count} posting-lag hidden).`,
      });
      setTimeout(() => setRunToast(null), 6000);
    }, 800);
  }

  async function handleSignOut() {
    if (supabaseConfigured) {
      const supabase = getSupabaseClient();
      await supabase.auth.signOut();
    } else {
      clearSessionCookie();
    }
    router.push("/login");
    router.refresh();
  }

  const items = NAV_ITEMS.filter((i) => i.roles.includes(user.role));

  return (
    <aside
      id="app-sidebar"
      aria-label="Main navigation"
      // `invisible` when the drawer is shut, not just translated away: a
      // translated element is still in the tab order, so tabbing from the
      // hamburger used to walk keyboard focus through eight links nobody could
      // see. It has to be CSS rather than the `inert` attribute, because the
      // same element is permanently visible at lg+ where `open` is always
      // false — hence `lg:visible`, which an attribute could not express.
      className={`w-sidebar-width h-screen fixed left-0 top-0 bg-primary-container flex flex-col py-6 z-50 shadow-xl transition-transform duration-200 lg:translate-x-0 lg:visible ${
        open ? "translate-x-0 visible" : "-translate-x-full invisible"
      }`}
    >
      <div className="px-6 mb-8 flex items-start justify-between">
        <div>
          <span className="block font-headline text-2xl font-bold text-white lowercase tracking-tight leading-none">
            cityfurnish
          </span>
          <p className="text-xs text-on-primary-container uppercase tracking-widest mt-1.5 opacity-60">
            Operations Portal
          </p>
        </div>
        {/* Close button — drawer only (mobile) */}
        <button
          onClick={onClose}
          className="lg:hidden text-on-primary-container hover:text-white -mr-1"
          title="Close menu"
        >
          <Icon name="close" size={22} />
        </button>
      </div>

      <nav className="flex-1 px-3 space-y-0.5">
        {items.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onClose}
              // The colour + left rule showed which page you were on; nothing
              // told a screen reader.
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "flex items-center gap-3 px-3 py-2.5 rounded-control bg-white/10 text-white border-l-[3px] border-primary-fixed-dim font-semibold transition-[background-color,border-color] duration-150"
                  : "flex items-center gap-3 px-3 py-2.5 rounded-control border-l-[3px] border-transparent text-on-primary-container opacity-70 hover:opacity-100 hover:bg-white/5 transition-[background-color,border-color,opacity] duration-150"
              }
            >
              <Icon name={item.icon} size={18} />
              <span className="text-sm">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {user.role === "ADMIN" && (
        <div className="px-3 space-y-2">
          <label
            htmlFor="reconcile-date"
            className="block px-1 text-[11px] uppercase tracking-wider text-on-primary-container opacity-60"
          >
            Reconcile date
          </label>
          <input
            id="reconcile-date"
            type="date"
            value={runDate}
            max={today}
            onChange={(e) => setRunDate(e.target.value)}
            disabled={running}
            title="Pick the date to reconcile (defaults to today)"
            className="w-full bg-white/10 border border-white/10 rounded-control text-white text-sm px-3 py-2 cursor-pointer [color-scheme:dark] disabled:opacity-50"
          />
          <button
            onClick={handleRunReconciliation}
            disabled={running}
            // text-white! is deliberate: this button overrides btn-primary's
            // accent background with white/10 on the always-navy sidebar, so it
            // must NOT inherit the theme-flipping --color-on-accent (which goes
            // near-black in dark mode and would vanish against the navy).
            className="btn btn-primary w-full bg-white/10! hover:bg-white/15! border border-white/10 text-white!"
          >
            <Icon
              name={running ? "progress_activity" : "sync_alt"}
              size={18}
              className={running ? "animate-spin" : ""}
            />
            <span>{running ? "Running…" : `Run for ${runDate}`}</span>
          </button>
        </div>
      )}

      {/* Portalled to <body> deliberately. This <aside> carries a `translate`,
          which makes it the containing block for any `position: fixed` child —
          so while the drawer is closed (translated -100%) the toast rendered
          off-screen, and a failed run reported itself where nobody could see
          it. The portal escapes that containing block. */}
      {runToast &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            role="status"
            aria-live="polite"
            className="fixed inset-x-4 bottom-4 lg:inset-x-auto lg:left-[276px] lg:bottom-8 lg:max-w-md card bg-primary-container text-white px-5 py-4 flex items-start gap-4 z-[80] border-white/10 shadow-xl"
          >
            <div
              className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center ${
                runToast.ok ? "bg-success-soft text-success" : "bg-danger-soft text-danger"
              }`}
            >
              <Icon name={runToast.ok ? "check" : "error"} size={18} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {runToast.ok ? "Reconciliation finished" : "Reconciliation failed"}
              </p>
              <p className="text-xs opacity-70 break-words">{runToast.text}</p>
            </div>
            <button
              onClick={() => setRunToast(null)}
              aria-label="Dismiss"
              className="btn-icon text-white! opacity-60 hover:opacity-100 ml-auto shrink-0"
            >
              <Icon name="close" size={18} />
            </button>
          </div>,
          document.body
        )}

      <div className="mt-4 px-3 pt-4 border-t border-white/10 space-y-1">
        <div className="px-3 py-1.5">
          <p className="text-xs text-on-primary-container truncate opacity-70">
            {user.email}
          </p>
        </div>
        <button
          onClick={handleSignOut}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-control text-on-primary-container opacity-70 hover:opacity-100 hover:bg-white/5 transition-[background-color,opacity] duration-150"
        >
          <Icon name="logout" size={18} />
          <span className="text-sm">Logout</span>
        </button>
      </div>
    </aside>
  );
}
