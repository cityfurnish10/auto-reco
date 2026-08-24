// GET /api/gate/devices — the enrolled phones, and who has signed in on each.
//
// The sign-in list carries refusals as well as successes. A guard forgetting a
// digit is noise; the same phone refusing five PINs in a row is the only signal
// anyone gets that somebody is trying handsets that are not theirs, and it only
// exists if the failures are kept.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { listDevices } from "../enrol/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const me = await getCurrentAppUser();
  if (!me || (me.role !== "admin" && me.role !== "manager")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // A manager sees their own city whatever they ask for.
  const city = me.role === "manager" ? me.city ?? null : req.nextUrl.searchParams.get("city");
  try {
    return NextResponse.json({ devices: await listDevices(city) });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not list devices" }, { status: 500 });
  }
}
