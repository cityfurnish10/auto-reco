import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { DemoStoreProvider } from "@/lib/demo-store";
import Sidebar from "./sidebar";
import ThemeToggle from "./theme-toggle";
import { Icon } from "@/components/icon";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getSessionUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <DemoStoreProvider>
      <div className="min-h-screen bg-surface-page">
        <Sidebar user={user} />

        <main className="ml-sidebar-width min-h-screen flex flex-col">
          <header className="h-14 sticky top-0 z-40 bg-surface-card shadow-card border-b border-border flex justify-between items-center px-container-margin w-full">
            <div className="flex items-center gap-4">
              <h2 className="font-headline text-lg text-text-primary font-bold">
                Reconciliation Portal
              </h2>
              {user.role === "ADMIN" ? (
                <span className="badge uppercase tracking-widest bg-accent text-white">
                  Admin View
                </span>
              ) : (
                <span className="chip">
                  <Icon name="location_on" size={14} />
                  {user.city} Warehouse
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <ThemeToggle />
              <button className="btn-icon" title="Notifications">
                <Icon name="notifications" size={20} />
              </button>
              <div className="flex items-center gap-3 pl-4 ml-2 border-l border-border">
                <div className="text-right">
                  <p className="text-sm text-text-primary font-medium">
                    {user.name}
                  </p>
                  <p className="text-xs text-text-muted uppercase font-semibold tracking-widest">
                    {user.role === "ADMIN" ? "Administrator" : "Warehouse Manager"}
                  </p>
                </div>
                <div className="w-9 h-9 rounded-full bg-accent text-white flex items-center justify-center text-xs font-bold">
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
    </DemoStoreProvider>
  );
}
