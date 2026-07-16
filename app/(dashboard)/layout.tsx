import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { DemoStoreProvider } from "@/lib/demo-store";
import DashboardShell from "./dashboard-shell";

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
      <DashboardShell user={user}>{children}</DashboardShell>
    </DemoStoreProvider>
  );
}
