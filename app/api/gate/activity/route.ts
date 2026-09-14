// What the gate has actually recorded — the manager's view of the app's output.
//
// Deliberately answers the questions a manager asks in the pilot, not a generic
// row dump: is it capturing everything, how much is typed rather than scanned,
// and how often is somebody overriding. The data is built in
// lib/gate/activity-data.ts, shared with the day's Excel export.

import { NextResponse, type NextRequest } from "next/server";
import { jsonRoute } from "@/lib/api/json-route";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { loadActivity } from "@/lib/gate/activity-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = jsonRoute("gate/activity", async (req: NextRequest) => {
  const me = await getCurrentAppUser();
  if (!me || (me.role !== "admin" && me.role !== "manager")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const sp = req.nextUrl.searchParams;
  try {
    return NextResponse.json(await loadActivity(createAdminClient(), {
      date: sp.get("date"),
      // A manager is pinned to their own city whatever they ask for.
      city: me.role === "manager" ? me.city : sp.get("city"),
      guardId: sp.get("guardId"),
      direction: sp.get("direction"),
      // Matched on the registration and on the name case-insensitively, never
      // on the raw text: one truck reached the gate under up to four spellings.
      vehicle: sp.get("vehicle"),
      agent: sp.get("agent"),
    }));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
});
