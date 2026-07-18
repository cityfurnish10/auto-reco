// GET /api/variances/pending-count — how many variances are awaiting approval.
// RLS-scoped: an admin sees the whole queue, a manager only their own city.
// Powers the header notification-bell badge (admin approval queue).

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { count, error } = await supabase
    .from("variances")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending_approval");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ count: count ?? 0 });
}
