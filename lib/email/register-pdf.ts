// The warehouse register, as a PDF, for one business date.
//
// Built from the ops-sheet rows this run actually reconciled (source_rows where
// source = 'SHEET') rather than exported from Google. Two reasons:
//
//   • Google's own export renders the WHOLE tab — ~1,500 rows of history — and
//     cannot be filtered to a date. This is just the one day.
//   • It would need drive.readonly on the service account. The Sheets client
//     holds spreadsheets.readonly and the Drive client holds drive.file (files
//     the app created), neither of which authorises the export endpoint.
//
// Because it is built from the same rows the engine consumed, the attachment
// and the numbers in the email cannot disagree.
//
// pdf-lib is used rather than pdfkit or puppeteer: pure JS with the standard
// fonts embedded, no native binaries and no headless Chrome, so it runs inside
// the 60s serverless ceiling.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface CityRegisterPdf {
  city: string;
  bytes: Uint8Array;
  filename: string;
  rowCount: number;
}

export interface RegisterPdfResult {
  /** One document per city that had ops-sheet rows. Empty when none did. */
  pdfs: CityRegisterPdf[];
  /** Why the list is empty — surfaced in the email body via registerAttachments. */
  reason?: string;
}

/**
 * Turn a register result into nodemailer attachments plus the one-line note
 * explaining an absence.
 *
 * Exists because all three send paths (cron digest, admin test, scheduled
 * drain) had the identical six-line map inline and all three dropped `reason`
 * on the floor — so a recipient wondering where the attachment went had
 * nothing to read, despite the field being documented as surfaced in the body.
 */
export function registerAttachments(res: RegisterPdfResult | null): {
  attachments?: { filename: string; content: Buffer; contentType: string }[];
  attachmentNote?: string;
} {
  if (res?.pdfs.length) {
    return {
      attachments: res.pdfs.map((r) => ({
        filename: r.filename,
        content: Buffer.from(r.bytes),
        contentType: "application/pdf",
      })),
    };
  }
  // `null` means buildRegisterPdfs THREW and every call site swallowed it. That
  // used to return {} — no attachment and no explanation, which is how a reader
  // ends up assuming there was simply nothing to send. Always say something.
  return {
    attachmentNote: res?.reason ?? "the register could not be built for this date",
  };
}

// "2026-07-30" -> "30-July-2026", the same convention as the email subject
// ("Movement Register- 30-July-2026"), so the attachment strip and the subject
// visibly belong to the same day. The ISO form was correct but machine-facing:
// a reader scanning five attachments should not have to parse y-m-d.
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
function fileDate(businessDate: string): string {
  const [y, m, d] = businessDate.split("-").map(Number);
  return y && m && d ? `${d}-${MONTHS[m - 1]}-${y}` : businessDate;
}
const titleCity = (c: string) => c.charAt(0) + c.slice(1).toLowerCase();

interface SheetRow {
  city: string;
  direction: string;
  barcode: string;
  product: string | null;
  so_number: string | null;
  ticket_id: string | null;
  customer: string | null;
  job_type: string | null;
  status: string | null;
}

// Landscape A4. The register is wide — ten columns — and portrait would force
// either a punishing font size or wrapped cells.
const PAGE_W = 842;
const PAGE_H = 595;
const MARGIN = 28;
const LINE_H = 13;
const FONT_SIZE = 7.5;
const HEADER_SIZE = 8;

const COLUMNS: { header: string; width: number; get: (r: SheetRow) => string }[] = [
  { header: "Dir", width: 26, get: (r) => r.direction ?? "" },
  { header: "Barcode", width: 118, get: (r) => r.barcode ?? "" },
  { header: "Item", width: 196, get: (r) => r.product ?? "" },
  { header: "SO / PO", width: 104, get: (r) => r.so_number ?? "" },
  { header: "Ticket", width: 96, get: (r) => r.ticket_id ?? "" },
  { header: "Customer", width: 118, get: (r) => r.customer ?? "" },
  { header: "Ops Type", width: 84, get: (r) => r.job_type ?? "" },
  { header: "Status", width: 64, get: (r) => r.status ?? "" },
];

// pdf-lib throws on characters the standard fonts cannot encode (WinAnsi), and
// customer names in this data carry the occasional non-Latin glyph. Strip to a
// safe range and truncate to the column width.
function safe(text: string, font: PDFFont, maxWidth: number): string {
  const cleaned = String(text ?? "").replace(/[^\x20-\x7E]/g, "");
  if (font.widthOfTextAtSize(cleaned, FONT_SIZE) <= maxWidth) return cleaned;
  let out = cleaned;
  while (out.length > 1 && font.widthOfTextAtSize(out + "…", FONT_SIZE) > maxWidth) {
    out = out.slice(0, -1);
  }
  return out + "…";
}

function drawHeaderRow(page: PDFPage, bold: PDFFont, y: number): void {
  let x = MARGIN;
  for (const col of COLUMNS) {
    page.drawText(col.header, { x, y, size: HEADER_SIZE, font: bold, color: rgb(0.25, 0.25, 0.3) });
    x += col.width;
  }
  page.drawLine({
    start: { x: MARGIN, y: y - 3 },
    end: { x: PAGE_W - MARGIN, y: y - 3 },
    thickness: 0.6,
    color: rgb(0.75, 0.75, 0.8),
  });
}

// One PDF per city, not one document holding all five. Each warehouse gets a
// file it can print and work from on its own, and a city manager forwarding
// theirs no longer hands over every other city's register with it.
export async function buildRegisterPdfs(
  db: SupabaseClient,
  businessDate: string
): Promise<RegisterPdfResult> {

  // Scope to ONE run. source_rows keeps every re-check pass for a date, so a
  // plain business_date filter returns the register several times over —
  // measured 4,106 rows for 2026-07-25 where the run itself pulled 896.
  const { data: runs } = await db
    .from("reconciliation_runs")
    .select("id")
    .eq("business_date", businessDate)
    .in("status", ["success", "partial"])
    .order("created_at", { ascending: false })
    .limit(1);
  const runId = runs?.[0]?.id as string | undefined;
  if (!runId) {
    return { pdfs: [], reason: "no completed reconciliation for this date" };
  }

  const rows: SheetRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("source_rows")
      .select("city,direction,barcode,product,so_number,ticket_id,customer,job_type,status")
      .eq("run_id", runId)
      .eq("source", "SHEET")
      // City groups the pages; id makes the order unique — city alone leaves
      // ties Postgres may break differently per page, repeating/skipping rows.
      .order("city", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) return { pdfs: [], reason: error.message };
    rows.push(...((data ?? []) as SheetRow[]));
    if (!data || data.length < 1000) break;
  }

  if (rows.length === 0) {
    // source_rows is pruned after 7 days, so a re-send of an older date finds
    // nothing. Say that rather than attaching empty documents.
    return {
      pdfs: [],
      reason: "no stored ops-sheet rows for this date (raw source rows are kept for 7 days)",
    };
  }

  const byCity = new Map<string, SheetRow[]>();
  for (const r of rows) {
    const list = byCity.get(r.city) ?? [];
    list.push(r);
    byCity.set(r.city, list);
  }

  const pdfs: CityRegisterPdf[] = [];

  for (const city of [...byCity.keys()].sort()) {
    // A fresh document per city — fonts are embedded per document, so they are
    // created inside the loop rather than shared.
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

    const cityRows = byCity.get(city)!;
    // OUT before IN, then barcode — the order a register is read in.
    cityRows.sort(
      (a, b) =>
        a.direction.localeCompare(b.direction) || String(a.barcode).localeCompare(String(b.barcode))
    );

    let page = pdf.addPage([PAGE_W, PAGE_H]);
    let y = PAGE_H - MARGIN;

    const title = (continued: boolean) => {
      page.drawText(`${titleCity(city)} — Warehouse Register — ${fileDate(businessDate)}`, {
        x: MARGIN,
        y,
        size: 12,
        font: bold,
        color: rgb(0.07, 0.09, 0.15),
      });
      page.drawText(
        continued
          ? "(continued)"
          : `${cityRows.length} row${cityRows.length === 1 ? "" : "s"} · business day 15:00–15:00 IST`,
        { x: MARGIN, y: y - 13, size: 8, font, color: rgb(0.45, 0.45, 0.5) }
      );
      y -= 30;
      drawHeaderRow(page, bold, y);
      y -= LINE_H;
    };

    title(false);

    for (const r of cityRows) {
      if (y < MARGIN + LINE_H) {
        page = pdf.addPage([PAGE_W, PAGE_H]);
        y = PAGE_H - MARGIN;
        title(true);
      }
      let x = MARGIN;
      for (const col of COLUMNS) {
        page.drawText(safe(col.get(r), font, col.width - 6), {
          x,
          y,
          size: FONT_SIZE,
          font,
          color: rgb(0.1, 0.1, 0.14),
        });
        x += col.width;
      }
      y -= LINE_H;
    }

    pdfs.push({
      city,
      bytes: await pdf.save(),
      filename: `Register-${titleCity(city)}-${fileDate(businessDate)}.pdf`,
      rowCount: cityRows.length,
    });
  }

  return { pdfs };
}
