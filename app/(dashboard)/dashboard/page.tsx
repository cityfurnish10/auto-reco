import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import AdminDashboard from "./admin-dashboard";
import ManagerDashboard from "./manager-dashboard";

export default async function DashboardPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  if (user.role === "MANAGER" && user.city) {
    return <ManagerDashboard user={user} />;
  }
  return <AdminDashboard user={user} />;
}
