// POST /api/gate/rejections/dismiss — write off a refusal no phone can clear.
//
// The refused-items tab is a to-do list (0046): a row leaves it when the SAME
// entry is later accepted, which is what "Try again" on the phone does. Some
// rows can never be accepted — a refusal reading "unknown trip" belongs to a
// trip that does not exist, so a retry reproduces it forever. Without an
// ending, those rows sit at the top of the list until people stop reading it.
//
// This is the other ending, and it is deliberately NOT the same one: a
// dismissal says a human decided the movement is never coming, which is not
// evidence that it was recorded. The two states are stored and shown
// separately for that reason (see migration 0047).
//
// Reversible — `undo: true` clears it. A mis-click must not permanently bury a
// real missing movement.

import { NextResponse, type NextRequest } from "next/server";
import { jsonRoute } from "@/lib/api/json-route";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A short fixed list, so the residue can be counted by cause rather than read
 * one row at a time. Free text lives in the note beside it.
 */
export const DISMISS_REASONS = {
  test: "Test entry, not a real movement",
  elsewhere: "The movement was recorded another way",
  never: "The movement never happened",
  unrecoverable: "The phone no longer has it",
} as const;

export type DismissReason = keyof typeof DISMISS_REASONS;

export const POST = jsonRoute("gate/rejections/dismiss", async (req: NextRequest) => {
  const me = await getCurrentAppUser();
  if (!me || (me.role !== "admin" && me.role !== "manager")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    id?: string; reason?: string; note?: string; undo?: boolean;
  };
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
  if (!body.undo && !(body.reason && body.reason in DISMISS_REASONS)) {
    return NextResponse.json({ error: "a reason is required" }, { status: 400 });
  }

  const admin = createAdminClient();

  // The ROW's city decides, never a parameter — otherwise an id is a key to
  // another gate's list for anyone who can guess one. Same rule as the photo
  // route.
  const found = await admin
    .from("gate_sync_rejections")
    .select("id, city, resolved_at")
    .eq("id", body.id)
    .maybeSingle();
  if (found.error) return NextResponse.json({ error: found.error.message }, { status: 500 });
  if (!found.data) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (me.role === "manager" && found.data.city !== me.city) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // An entry the guard got in after all is already answered, and writing it off
  // would replace a fact with an opinion.
  if (!body.undo && found.data.resolved_at) {
    return NextResponse.json({ error: "this entry was accepted after all — nothing to dismiss" }, { status: 409 });
  }

  const patch = body.undo
    ? { dismissed_at: null, dismissed_by: null, dismiss_reason: null, dismiss_note: null }
    : {
        dismissed_at: new Date().toISOString(),
        dismissed_by: me.id,
        dismiss_reason: body.reason,
        dismiss_note: (body.note ?? "").trim().slice(0, 500) || null,
      };

  const up = await admin.from("gate_sync_rejections").update(patch).eq("id", body.id);
  // 0047 is applied by hand. Say so plainly rather than reporting a Postgres
  // error string to a manager who cannot act on it.
  if (up.error?.code === "42703") {
    return NextResponse.json({ error: "migration 0047 has not been applied yet" }, { status: 503 });
  }
  if (up.error) return NextResponse.json({ error: up.error.message }, { status: 500 });

  return NextResponse.json({ ok: true, dismissed: !body.undo });
});
