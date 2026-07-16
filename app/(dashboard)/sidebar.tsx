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

  function handleRunReconciliation() {
    if (running) return;
    setRunning(true);
    // Demo: engine runs client-side over sample raw feeds for today.
    // With Supabase this becomes POST /api/reconcile over staged rows.
    setTimeout(() => {
      const today = new Date().toISOString().slice(0, 10);
      const run = runAllCities(buildSampleRowsByCity(today));
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
          <h1 className="font-headline text-lg font-bold text-white uppercase tracking-wider">
            CityFurnish
          </h1>
          <p className="text-xs text-on-primary-container uppercase tracking-widest mt-1 opacity-60">
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
        <div className="px-3">
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
            <span>{running ? "Running…" : "Run Reconciliation"}</span>
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
