// PATCH /api/variances/[id] — variance resolution lifecycle.
//
// Workflow: a city manager SUBMITS a variance for approval (→ pending_approval)
// with a reason; an admin then APPROVES it (→ closed) or REJECTS it (→ open,
// with a note). Admins may also close/dispute/reopen directly.
//
// Two authorization layers:
//  • RLS (variances_update) — row scope: admin any city, manager their own city.
//  • This route — ROLE gate: approve/reject/close/dispute/reopen are admin-only
//    (RLS cannot distinguish manager-vs-admin writes; a manager may only submit).
//
// Body: { action, reason?, note? }. `reason` is required for submit + close.

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentAppUser } from "@/lib/db/current-user";

type Action = "submit" | "approve" | "reject" | "close" | "dispute" | "reopen";

const ALL_ACTIONS: Action[] = ["submit", "approve", "reject", "close", "dispute", "reopen"];
// Everything except "submit" changes an approval/closure decision → admin only.
const ADMIN_ONLY: Action[] = ["approve", "reject", "close", "dispute", "reopen"];

function buildUpdate(action: Exclude<Action, "approve">, appUserId: string, now: string, reason?: string, note?: string) {
  switch (action) {
    case "submit":
      return {
        status: "pending_approval" as const,
        submitted_by: appUserId,
        submitted_at: now,
        submit_reason: reason ?? null,
        submit_note: note ?? null,
        rejection_note: null,
        closed_by: null,
        closed_at: null,
        closure_reason: null,
        closure_note: null,
      };
    case "reject":
      return {
        status: "open" as const,
        rejection_note: note ?? reason ?? null,
        closed_by: null,
        closed_at: null,
        closure_reason: null,
        closure_note: null,
      };
    case "close":
      return {
        status: "closed" as const,
        closure_reason: reason ?? null,
        closure_note: note ?? null,
        closed_by: appUserId,
        closed_at: now,
        rejection_note: null,
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
        rejection_note: null,
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
    // Approving = closing on the manager's behalf. Carry the manager's submit
    // reason/note into the closure fields (so the closure analytics + audit
    // trail stay meaningful), unless the admin overrode them.
    const { data: cur, error: curErr } = await supabase
      .from("variances")
      .select("submit_reason, submit_note")
      .eq("id", id)
      .single();
    if (curErr) {
      const status = curErr.code === "PGRST116" ? 403 : 500;
      return NextResponse.json({ error: curErr.message }, { status });
    }
    update = {
      status: "closed",
      closed_by: appUser.id,
      closed_at: now,
      closure_reason: body.reason ?? cur?.submit_reason ?? "Approved",
      closure_note: body.note ?? cur?.submit_note ?? null,
      rejection_note: null,
    };
  } else {
    update = buildUpdate(action, appUser.id, now, body.reason, body.note);
  }

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
