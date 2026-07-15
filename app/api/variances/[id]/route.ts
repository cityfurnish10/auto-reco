// PATCH /api/variances/[id] — close / dispute / reopen a variance.
// Writes through the cookie-bound server client, so the variances_update RLS
// policy is the real authorization boundary (admin, or manager of that city);
// this route can't do anything RLS wouldn't already allow.
//
// Note on the schema: `status` only has 3 values (open|in_progress|closed) —
// "dispute" maps to in_progress (a contested-but-not-yet-resolved state),
// matching the same 3-state model the plan's Section B describes.
//
// Body: { action: "close" | "dispute" | "reopen", reason?: string, note?: string }
// `reason` is required for "close" (closure_reason).

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentAppUser } from "@/lib/db/current-user";

type Action = "close" | "dispute" | "reopen";

function buildUpdate(action: Action, appUserId: string, reason?: string, note?: string) {
  const now = new Date().toISOString();
  switch (action) {
    case "close":
      return {
        status: "closed" as const,
        closure_reason: reason ?? null,
        closure_note: note ?? null,
        closed_by: appUserId,
        closed_at: now,
      };
    case "dispute":
      return {
        status: "in_progress" as const,
        closure_reason: reason ?? null,
        closure_note: note ?? null,
        closed_by: null,
        closed_at: null,
      };
    case "reopen":
      return {
        status: "open" as const,
        closure_reason: null,
        closure_note: null,
        closed_by: null,
        closed_at: null,
      };
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const appUser = await getCurrentAppUser();
  if (!appUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { action?: string; reason?: string; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const action = body.action as Action;
  if (!["close", "dispute", "reopen"].includes(action)) {
    return NextResponse.json(
      { error: "action must be one of: close, dispute, reopen" },
      { status: 400 }
    );
  }
  if (action === "close" && !body.reason) {
    return NextResponse.json(
      { error: "reason is required to close a variance" },
      { status: 400 }
    );
  }

  const update = buildUpdate(action, appUser.id, body.reason, body.note);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("variances")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    // RLS denies (not admin / not this city) surfaces as "no rows" via PGRST116.
    const status = error.code === "PGRST116" ? 403 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json({ data });
}
