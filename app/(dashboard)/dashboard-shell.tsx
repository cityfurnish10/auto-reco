"use client";

// Client shell for the dashboard: owns the mobile drawer state and coordinates
// the sidebar (off-canvas drawer below lg, permanent rail at lg+), the mobile
// backdrop, and the header hamburger. layout.tsx stays a server component (it
// resolves the session) and just renders this around the page children.

import { useState } from "react";
import type { SessionUser } from "@/lib/demo-auth";
import Sidebar from "./sidebar";
import ThemeToggle from "./theme-toggle";
import { Icon } from "@/components/icon";

export default function DashboardShell({
  user,
  children,
}: {
  user: SessionUser;
  children: React.ReactNode;
}) {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className="min-h-screen bg-surface-page">
      <Sidebar user={user} open={navOpen} onClose={() => setNavOpen(false)} />

      {/* Mobile backdrop — only when the drawer is open, below lg */}
      {navOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden
        />
      )}

      <main className="lg:ml-sidebar-width min-h-screen flex flex-col">
        <header className="h-14 sticky top-0 z-30 bg-surface-card shadow-card border-b border-border flex justify-between items-center px-container-margin w-full">
          <div className="flex items-center gap-3 min-w-0">
            {/* Hamburger — drawer trigger, mobile only */}
            <button
              onClick={() => setNavOpen(true)}
              className="btn-icon lg:hidden"
              title="Open menu"
              aria-label="Open navigation menu"
            >
              <Icon name="menu" size={22} />
            </button>
            <h2 className="font-headline text-lg text-text-primary font-bold truncate">
              Reconciliation Portal
            </h2>
            {user.role === "ADMIN" ? (
              <span className="badge uppercase tracking-widest bg-accent text-white hidden sm:inline-flex">
                Admin View
              </span>
            ) : (
              <span className="chip hidden sm:inline-flex">
                <Icon name="location_on" size={14} />
                {user.city} Warehouse
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <button className="btn-icon hidden sm:inline-flex" title="Notifications">
              <Icon name="notifications" size={20} />
            </button>
            <div className="flex items-center gap-3 sm:pl-4 sm:ml-2 sm:border-l border-border">
              <div className="text-right hidden sm:block">
                <p className="text-sm text-text-primary font-medium">{user.name}</p>
                <p className="text-xs text-text-muted uppercase font-semibold tracking-widest">
                  {user.role === "ADMIN" ? "Administrator" : "Warehouse Manager"}
                </p>
              </div>
              <div className="w-9 h-9 rounded-full bg-accent text-white flex items-center justify-center text-xs font-bold shrink-0">
                {user.name
                  .split(" ")
                  .map((p) => p[0])
                  .slice(0, 2)
                  .join("")
                  .toUpperCase()}
              </div>
            </div>
          </div>
        </header>

        <div className="flex-1">{children}</div>
      </main>
    </div>
  );
}
