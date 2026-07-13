import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import UploadsClient from "./uploads-client";

export default async function UploadsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  return <UploadsClient user={user} />;
}
