// GET /api/email/archive?date=YYYY-MM-DD — admin-only list of every email the
// system sent (or tried to send) on that IST calendar day, from email_logs.
// Feeds the "Sent emails" archive card on the Email Digest page; the actual
// delivered HTML is served per-row by /api/email/archive/[id].

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { istDayToUtcWindow } from "@/lib/connectors/ist-window";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const me = await getCurrentAppUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const date = req.nextUrl.searchParams.get("date")?.trim();
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date=YYYY-MM-DD is required" }, { status: 400 });
  }

  const { startUtc, endUtcExclusive } = istDayToUtcWindow(date);
  const db = createAdminClient();
  const { data, error } = await db
    .from("email_logs")
    .select("id, kind, business_date, status, recipients, cc, bcc, notes, error, created_at")
    .gte("created_at", startUtc)
    .lt("created_at", endUtcExclusive)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ data: data ?? [] });
}
