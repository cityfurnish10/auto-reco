import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import AdminDashboard from "./admin-dashboard";
import ManagerDashboard from "./manager-dashboard";
import { Icon } from "@/components/icon";

export default async function DashboardPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  // Only admins get the all-cities dashboard.
  if (user.role === "ADMIN") {
    return <AdminDashboard user={user} />;
  }

  // A non-admin with no city is unprovisioned — fail-closed empty state
  // (never the all-cities view).
  if (!user.city) {
    return (
      <div className="p-container-margin">
        <div className="card p-8 text-center max-w-md mx-auto mt-10">
          <Icon name="lock" size={32} className="text-text-muted mx-auto mb-3" />
          <h2 className="font-headline text-lg text-text-primary mb-1">No warehouse assigned</h2>
          <p className="text-sm text-text-muted">
            Your account isn&apos;t linked to a city yet. Ask an administrator to assign
            you a warehouse before you can see reconciliation data.
          </p>
        </div>
      </div>
    );
  }

  // City manager → their own warehouse only.
  return <ManagerDashboard user={user} />;
}
