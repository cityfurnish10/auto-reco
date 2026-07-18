// Admin-only management of deferred/scheduled digest sends (feature: "send the
// email once the variances are resolved, 1-2 days later"). Rows land in
// scheduled_emails and are drained by the daily email-digest cron.
//
//   POST   /api/email/schedule   { businessDate?, delayDays?, sendAt?, requireResolved?, to?, cc?, bcc?, notes? }
//   GET    /api/email/schedule                              — list recent scheduled sends
//   DELETE /api/email/schedule?id=<uuid>                    — cancel a pending send

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentAppUser } from "@/lib/db/current-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireAdmin() {
  const me = await getCurrentAppUser();
  if (!me || me.role !== "admin") return null;
  return me;
}

const clean = (list?: string[]): string[] =>
  (Array.isArray(list) ? list : []).map((s) => s.trim()).filter(Boolean);

export async function POST(req: NextRequest) {
  const me = await requireAdmin();
  if (!me) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: {
    businessDate?: string;
    delayDays?: number;
    sendAt?: string;
    requireResolved?: boolean;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    notes?: string;
  } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body → defaults */
  }

  const db = createAdminClient();

  // Business date: explicit, else the latest reconciled run.
  let businessDate = body.businessDate?.trim();
  if (!businessDate) {
    const { data } = await db
      .from("reconciliation_runs")
      .select("business_date")
      .order("business_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    businessDate = data?.business_date as string | undefined;
  }
  if (!businessDate) {
    return NextResponse.json({ error: "No reconciled run found yet — run a reconcile first." }, { status: 404 });
  }

  // send_at: explicit ISO, else businessDate + delayDays at 09:00 IST (03:30 UTC).
  let sendAt = body.sendAt?.trim();
  if (!sendAt) {
    const delayDays = Number.isFinite(body.delayDays) ? Math.max(0, Math.min(30, Number(body.delayDays))) : 2;
    const d = new Date(`${businessDate}T03:30:00.000Z`); // 09:00 IST
    d.setUTCDate(d.getUTCDate() + delayDays);
    sendAt = d.toISOString();
  }

  const { data, error } = await db
    .from("scheduled_emails")
    .insert({
      kind: "digest",
      business_date: businessDate,
      send_at: sendAt,
      status: "pending",
      require_resolved: body.requireResolved !== false, // default true
      recipients: clean(body.to),
      cc: clean(body.cc),
      bcc: clean(body.bcc),
      notes: body.notes?.trim() || null,
      scheduled_by: me.id,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, data });
}

export async function GET() {
  const me = await requireAdmin();
  if (!me) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const db = createAdminClient();
  const { data, error } = await db
    .from("scheduled_emails")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}

export async function DELETE(req: NextRequest) {
  const me = await requireAdmin();
  if (!me) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const db = createAdminClient();
  // Only a still-pending send can be canceled.
  const { data, error } = await db
    .from("scheduled_emails")
    .update({ status: "canceled" })
    .eq("id", id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "not found or no longer pending" }, { status: 409 });
  return NextResponse.json({ ok: true });
}
