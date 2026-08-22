import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import GateClient from "./gate-client";

export const dynamic = "force-dynamic";

export default async function GatePage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  // Passed down rather than fetched from the client: the same pattern the
  // uploads page already uses, and it means the city selector knows on first
  // paint whether it is needed instead of flickering in.
  return <GateClient user={user} />;
}
