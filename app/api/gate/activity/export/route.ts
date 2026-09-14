// GET /api/gate/activity/export?date=&city= — the whole day as an Excel file.
//
// Asked for 14 Sep 2026: "download all the outward/inward data for any
// particular day, regardless of the transport and agent … an excel file with
// all heading and rows." So: every trip opened that calendar day (IST) in the
// city, one sheet for Outward and one for Inward, the same register columns as
// the trip table on screen (lib/gate/register.ts) plus trip context. The
// screen's transport, agent, guard and direction filters are deliberately NOT
// applied — this is the day, not the view.
//
// Duplicates are included and marked, not dropped: the file is the full record,
// and "Duplicate — not counted" is information a reader of the file needs.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { loadActivity } from "@/lib/gate/activity-data";
import { buildActivityWorkbook } from "@/lib/gate/activity-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const me = await getCurrentAppUser();
  if (!me || (me.role !== "admin" && me.role !== "manager")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const sp = req.nextUrl.searchParams;
  const city = me.role === "manager" ? me.city : sp.get("city");

  let data;
  try {
    data = await loadActivity(createAdminClient(), { date: sp.get("date"), city });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }

  const wb = buildActivityWorkbook(data);
  const buf = await wb.xlsx.writeBuffer();
  const file = `gate-activity-${city ?? "ALL"}-${data.businessDate}.xlsx`;
  return new NextResponse(Buffer.from(buf as ArrayBuffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${file}"`,
      "Cache-Control": "no-store",
    },
  });
}
