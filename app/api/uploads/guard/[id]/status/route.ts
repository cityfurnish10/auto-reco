// GET /api/uploads/guard/[id]/status — the poll endpoint the review UI calls
// every few seconds while status='ocr_running'. Each call is a quick
// check-and-advance: if Azure isn't done yet, just report "still running"; if
// it succeeded, reconstruct the row/column grid per page (table-reconstruct.ts),
// best-effort-guess each page's direction (direction-detect.ts), save
// parsed_rows + an immutable ocr_raw_snapshot, and advance to 'needs_review'.
// This never blocks on Azure inside one request — that's what the submit-then-
// poll split is for.

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkReadJob } from "@/lib/connectors/ocr/azure-vision";
import { reconstructGrid } from "@/lib/connectors/ocr/table-reconstruct";
import { detectPageDirection } from "@/lib/connectors/ocr/direction-detect";
import type { ParsedGuardRow } from "@/lib/db/schema";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data: upload, error: fetchError } = await supabase
    .from("guard_uploads")
    .select("*")
    .eq("id", id)
    .single();
  if (fetchError || !upload) {
    return NextResponse.json({ error: "upload not found or not accessible" }, { status: 404 });
  }

  if (upload.status !== "ocr_running") {
    return NextResponse.json({ data: upload });
  }
  if (!upload.ocr_operation_id) {
    return NextResponse.json({ error: "ocr_running but no operation id recorded" }, { status: 500 });
  }

  const admin = createAdminClient();
  try {
    const result = await checkReadJob(upload.ocr_operation_id);

    if (result.status === "running") {
      return NextResponse.json({ data: upload }); // still processing — poll again shortly
    }

    if (result.status === "failed") {
      const { data: updated } = await admin
        .from("guard_uploads")
        .update({ status: "failed", error: "Azure OCR job failed" })
        .eq("id", id)
        .select()
        .single();
      return NextResponse.json({ data: updated });
    }

    // succeeded — reconstruct + direction-detect per page
    const parsedRows: ParsedGuardRow[] = [];
    (result.pages ?? []).forEach((pageLines, pageIdx) => {
      const pageNum = pageIdx + 1;
      const direction = detectPageDirection(pageLines);
      for (const r of reconstructGrid(pageLines)) {
        parsedRows.push({
          page: pageNum,
          rowIndex: r.rowIndex,
          direction,
          cells: r.cells,
          confidence: r.confidence,
        });
      }
    });

    const { data: updated, error: updateError } = await admin
      .from("guard_uploads")
      .update({
        status: "needs_review",
        parsed_rows: parsedRows,
        ocr_raw_snapshot: parsedRows,
        rows_parsed: parsedRows.length,
      })
      .eq("id", id)
      .select()
      .single();
    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }
    return NextResponse.json({ data: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await admin.from("guard_uploads").update({ status: "failed", error: message }).eq("id", id);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
