"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getSupabaseClient } from "@/lib/supabase/client";
import { clearSessionCookie, type SessionUser } from "@/lib/demo-auth";
import { useDemoStore } from "@/lib/demo-store";
import { runAllCities } from "@/lib/engine/run";
import { buildSampleRowsByCity } from "@/lib/sample-raw-sources";
import { Icon } from "@/components/icon";

const supabaseConfigured =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
  !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard", roles: ["ADMIN", "MANAGER"] },
  { href: "/uploads", label: "Guard Upload", icon: "upload_file", roles: ["ADMIN", "MANAGER"] },
  { href: "/leaderboard", label: "Leaderboard", icon: "leaderboard", roles: ["ADMIN", "MANAGER"] },
  { href: "/users", label: "User Management", icon: "group", roles: ["ADMIN"] },
  { href: "/system-health", label: "System Health", icon: "health_and_safety", roles: ["ADMIN"] },
  { href: "/analytics", label: "Analytics", icon: "monitoring", roles: ["ADMIN"] },
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
  const [running, setRunning] = useState(false);
  const [runToast, setRunToast] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  const [runDate, setRunDate] = useState(today); // which date the run reconciles

  async function handleRunReconciliation() {
    if (running) return;

    // Real mode: trigger the actual server-side pipeline (POST /api/reconcile),
    // same as the nightly cron, then tell the dashboard to refetch.
    if (supabaseConfigured) {
      if (
        !window.confirm(
          `Run reconciliation for ${runDate} now? It pulls all four sources (guard, sheet, DT, Odoo) and can take up to a minute.`
        )
      ) {
        return;
      }
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
        setRunToast(
          `Run ${json.runDate} · ${json.status} — ${c.real_count ?? 0} REAL to chase, ${c.info_count ?? 0} INFO, ${json.variancesUpserted ?? 0} variances stored.`
        );
        // Nudge any open dashboard to reload its data in place.
        window.dispatchEvent(new CustomEvent("reconcile:complete"));
      } catch (e) {
        setRunToast(`Reconciliation failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setRunning(false);
        setTimeout(() => setRunToast(null), 8000);
      }
      return;
    }

    // Demo mode: engine runs client-side over sample raw feeds for the date.
    setRunning(true);
    setTimeout(() => {
      const run = runAllCities(buildSampleRowsByCity(runDate));
      applyReconciliationRun(run);
      setRunning(false);
      setRunToast(
        `Run complete — ${run.combined.real_count} REAL to chase, ${run.combined.info_count} INFO (dampened) across ${run.perCity.length} cities.`
      );
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
      className={`w-sidebar-width h-screen fixed left-0 top-0 bg-primary-container flex flex-col py-6 z-50 shadow-xl transition-transform duration-200 lg:translate-x-0 ${
        open ? "translate-x-0" : "-translate-x-full"
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
            className="btn btn-primary w-full bg-white/10! hover:bg-white/15! border border-white/10"
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

      {runToast && (
        <div className="fixed inset-x-4 bottom-4 lg:inset-x-auto lg:left-[276px] lg:bottom-8 card bg-primary-container text-white px-6 py-4 flex items-center gap-4 z-[80] border-white/10">
          <div className="w-8 h-8 rounded-full bg-success-soft text-success flex items-center justify-center">
            <Icon name="check" size={18} />
          </div>
          <div>
            <p className="text-sm font-medium">Reconciliation finished</p>
            <p className="text-xs opacity-70">{runToast}</p>
          </div>
          <button
            onClick={() => setRunToast(null)}
            className="btn-icon text-white/60! hover:text-white! ml-2"
          >
            <Icon name="close" size={18} />
          </button>
        </div>
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
