// Admin-only persistence for the digest recipient list.
//   GET  → the saved RecipientState (or state: null when never saved)
//   PUT  { state: RecipientState } → sanitize + save
//
// Backed by a JSON document in the private "app-config" Storage bucket (see
// lib/email/recipient-store.ts). The compose panel autosaves through this
// route, and the nightly digest cron reads the same document — so an address
// added or removed in the UI survives refreshes AND changes who the scheduled
// digest actually goes to.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { loadRecipientState, saveRecipientState } from "@/lib/email/recipient-store";
import { sanitizeRecipientState } from "@/lib/email/recipient-list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const me = await getCurrentAppUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const state = await loadRecipientState(createAdminClient());
  return NextResponse.json({ state });
}

export async function PUT(req: NextRequest) {
  const me = await getCurrentAppUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: { state?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const state = sanitizeRecipientState(body.state);
  try {
    await saveRecipientState(createAdminClient(), state);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true, state });
}
