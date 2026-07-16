// Background OCR job — processes uploaded guard-register PDFs into stored rows,
// no human review. Runs on its own schedule (see vercel.json) so registers are
// OCR'd soon after upload; the reconcile cron then just reads the results.
//
// Auth: same CRON_SECRET bearer as /api/cron/reconcile. GET (Vercel Cron) and
// POST (manual/curl). Optional ?date=YYYY-MM-DD scopes to one business date;
// otherwise every pending upload is processed (bounded by ?limit, default 25).

import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { processPendingGuardUploads } from "@/lib/connectors/ocr/process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handle(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 500 });
  }

  const businessDate = req.nextUrl.searchParams.get("date") || undefined;
  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Math.max(1, Math.min(100, Number(limitParam))) : 25;

  const db = createAdminClient();
  try {
    const summary = await processPendingGuardUploads(db, { businessDate, limit });
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
