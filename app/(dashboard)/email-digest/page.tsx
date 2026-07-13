import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import EmailPreview from "./email-preview";

export default async function EmailDigestPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  // Admin-only surface (managers don't send the management digest).
  if (user.role !== "ADMIN") redirect("/dashboard");

  return <EmailPreview />;
}
