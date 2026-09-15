// GET /api/gate/flags — the two review sections that are not face checks.
//
//   location  check-ins whose GPS fell outside the gate
//   scanning  rows the gate REFUSED, with the reason (0033)
//
// Kept apart from /api/gate/reviews because they are different questions with
// different answers. A face check asks "was this the right person?" and a human
// decides. These two ask "why did the system say no?" and are read rather than
// decided — the useful response to a rejected manual entry is to go and add it
// properly, not to tick a box here.
//
// Scoped like every gate screen: a city manager sees their own city, an admin
// sees all.

import { istDayRange, isIsoDate } from "@/lib/gate/calendar";
import { NextResponse, type NextRequest } from "next/server";
import { jsonRoute } from "@/lib/api/json-route";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = jsonRoute("gate/flags", async (req: NextRequest) => {
  const me = await getCurrentAppUser();
  if (!me || (me.role !== "admin" && me.role !== "manager")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const admin = createAdminClient();
  const city = me.role === "manager" ? (me.city ?? "") : req.nextUrl.searchParams.get("city");
  // A calendar day (IST), matched on when it happened — as the Reviews tab
  // already does — not on the warehouse day stored beside it.
  const qd = req.nextUrl.searchParams.get("date");
  const day = isIsoDate(qd) ? istDayRange(qd) : null;

  // ── Location ──────────────────────────────────────────────────────────
  // The view carries metres_from_gate and pin_unconfirmed alongside each row,
  // because a flag measured against a coordinate nobody has ever stood on is a
  // question about the PIN at least as much as about the guard.
  let loc = admin.from("gate_location_flags")
    .select("shift_id,guard_name,city,business_date,checked_in_at,metres_from_gate,radius_m,pin_unconfirmed")
    .order("checked_in_at", { ascending: false })
    .limit(200);
  if (city) loc = loc.eq("city", city);
  if (day) loc = loc.gte("checked_in_at", day.from).lt("checked_in_at", day.to);

  // ── Scanning ──────────────────────────────────────────────────────────
  // Outstanding refusals only — a movement that is on a phone and not in the
  // record. A row leaves the list two ways, and they are NOT the same: the
  // guard retried and it was accepted (resolved_at, 0046), or a manager wrote
  // it off as never coming (dismissed_at, 0047). Both are history and shown
  // only when asked for; the tab labels them differently, because a dismissal
  // is a decision and an acceptance is a fact.
  const includeResolved = req.nextUrl.searchParams.get("resolved") === "1";
  // Both migrations are applied by hand, possibly not yet. Degrade one column
  // at a time rather than failing the tab — see trap 3 in CLAUDE.md.
  const COLS = "id,client_id,kind,city,reason,summary,attempts,business_date,rejected_at,app_users!guard_id(name)";
  const rejQuery = (level: "dismissed" | "resolved" | "base") => {
    let q = admin.from("gate_sync_rejections")
      .select(
        level === "dismissed"
          ? `${COLS},resolved_at,dismissed_at,dismiss_reason,dismiss_note`
          : level === "resolved" ? `${COLS},resolved_at` : COLS
      )
      .order("rejected_at", { ascending: false })
      .limit(200);
    if (city) q = q.eq("city", city);
    if (day) q = q.gte("rejected_at", day.from).lt("rejected_at", day.to);
    if (level !== "base" && !includeResolved) q = q.is("resolved_at", null);
    if (level === "dismissed" && !includeResolved) q = q.is("dismissed_at", null);
    return q;
  };

  let [l, r] = await Promise.all([loc, rejQuery("dismissed")]);
  if (r.error?.code === "42703") r = await rejQuery("resolved") as typeof r;
  if (r.error?.code === "42703") r = await rejQuery("base") as typeof r;

  // Each section fails on its own. A missing migration on one must not take the
  // whole tab down and hide the other — which is exactly the sort of blank page
  // that gets read as "nothing to review".
  return NextResponse.json({
    location: l.error ? [] : (l.data ?? []),
    locationError: l.error?.message ?? null,
    scanning: r.error ? [] : (r.data ?? []),
    scanningError: r.error?.message ?? null,
  }, { headers: { "Cache-Control": "no-store" } });
});
