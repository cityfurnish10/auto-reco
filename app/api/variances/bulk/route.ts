// PATCH /api/variances/bulk — one lifecycle action across many variances.
//
// WHY: the queue is a few hundred rows deep at 25 per page, so a morning of
// triage was ~1,000 individual interactions. The approval queue is the worst
// case, because those rows are already vetted — a manager wrote a reason on
// each one — and "approve all 30 from Hyderabad" is the obvious move.
//
// Authorization is identical to the single-row route and deliberately shares
// its buildUpdate(), so the two can never drift on what "reject" writes:
//   • RLS (variances_update) scopes rows — admin any city, manager their own.
//   • This route ROLE-gates: everything except "submit" is admin-only.
//
// Body: { ids: string[], action, reason?, note? }.
//
// PARTIAL SUCCESS IS REAL AND IS REPORTED. RLS silently drops rows the caller
// may not touch, and a bulk approve legitimately skips rows that moved on since
// the page was rendered. The response always states updated vs skipped counts
// rather than implying every id was applied.

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { ALL_ACTIONS, ADMIN_ONLY, buildUpdate, type Action } from "../[id]/actions";

// A bulk call is one statement; this bounds both the URL-length of the IN list
// and the blast radius of a mistake. The UI pages at 200, so a "select all on
// this page" always fits.
const MAX_IDS = 500;

export async function PATCH(req: NextRequest) {
  const appUser = await getCurrentAppUser();
  if (!appUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { ids?: unknown; action?: string; reason?: string; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const ids = Array.isArray(body.ids)
    ? [...new Set(body.ids.filter((v): v is string => typeof v === "string" && v.length > 0))]
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "ids must be a non-empty array" }, { status: 400 });
  }
  if (ids.length > MAX_IDS) {
    return NextResponse.json(
      { error: `at most ${MAX_IDS} variances can be updated in one call (got ${ids.length})` },
      { status: 400 }
    );
  }

  const action = body.action as Action;
  if (!ALL_ACTIONS.includes(action)) {
    return NextResponse.json(
      { error: `action must be one of: ${ALL_ACTIONS.join(", ")}` },
      { status: 400 }
    );
  }
  if (ADMIN_ONLY.includes(action) && appUser.role !== "admin") {
    return NextResponse.json(
      { error: `only an admin can ${action} a variance` },
      { status: 403 }
    );
  }
  if ((action === "submit" || action === "close") && !body.reason) {
    return NextResponse.json(
      { error: `reason is required to ${action} a variance` },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const now = new Date().toISOString();

  let update: Record<string, unknown>;
  if (action === "approve") {
    // The single-row route carries each manager's own submit reason into the
    // closure fields. That is per-row and cannot be expressed in one UPDATE, so
    // a bulk approve REQUIRES an explicit reason from the admin and applies it
    // uniformly — recording "approved in bulk by <admin>" is honest, whereas
    // silently stamping one manager's reason onto thirty rows would not be.
    if (!body.reason) {
      return NextResponse.json(
        {
          error:
            "reason is required for a bulk approve — per-row submit reasons cannot be carried across a batch",
        },
        { status: 400 }
      );
    }
    update = {
      status: "closed",
      closed_by: appUser.id,
      closed_at: now,
      closure_reason: body.reason,
      closure_note: body.note ?? null,
      rejection_note: null,
    };
  } else {
    update = buildUpdate(action, appUser.id, now, body.reason, body.note);
  }

  const { data, error } = await supabase
    .from("variances")
    .update(update)
    .in("id", ids)
    .select("id");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const updated = data?.length ?? 0;
  return NextResponse.json({
    action,
    requested: ids.length,
    updated,
    // Non-zero means RLS blocked rows, or they were deleted between the page
    // rendering and the click. The UI surfaces this instead of claiming success.
    skipped: ids.length - updated,
    updatedIds: (data ?? []).map((r) => r.id as string),
  });
}
