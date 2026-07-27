// Pending List route. Server component so the session resolves before render,
// matching dashboard/page.tsx — the client half receives an already-typed user.
//
// Deliberately NOT in middleware.ts's ADMIN_ONLY_PATHS: city managers need this
// page. Their scoping comes from the variances_select RLS policy, not from the
// route.

import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { Icon } from "@/components/icon";
import PendingListClient from "./pending-list-client";

export default async function PendingListPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  // A non-admin with no city is unprovisioned — fail closed rather than
  // falling through to an all-cities view, same rule as the dashboard.
  if (user.role !== "ADMIN" && !user.city) {
    return (
      <div className="p-container-margin">
        <div className="card p-8 text-center max-w-md mx-auto mt-10">
          <Icon name="lock" size={32} className="text-text-muted mx-auto mb-3" />
          <h2 className="font-headline text-lg text-text-primary mb-1">No warehouse assigned</h2>
          <p className="text-sm text-text-muted">
            Your account isn&apos;t linked to a city yet. Ask an administrator to assign you a
            warehouse before you can see the pending list.
          </p>
        </div>
      </div>
    );
  }

  return <PendingListClient user={user} />;
}
