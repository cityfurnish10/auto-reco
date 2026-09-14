// The day's gate activity as an Excel workbook — Outward and Inward sheets, the
// register columns shared with the screen (lib/gate/register.ts), and trip
// context. Kept apart from the route so it can be built and checked without a
// request. See app/api/gate/activity/export/route.ts for what is included.

import ExcelJS from "exceljs";
import type { ActivityPayload } from "./activity-data";
import { FILE_HEADER, fileRow } from "./register";

const istDateTime = (iso: string | null | undefined) => iso
  ? new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", hour12: false }).replace(",", "") : "";

/**
 * A cell a spreadsheet will not run. A barcode comes from a sticker anyone can
 * print; "=HYPERLINK(...)" in a cell is a formula to Excel unless it is written
 * as plain text.
 */
export const safeCell = (v: string | null | undefined) => {
  const s = v ?? "";
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};

export const EXPORT_HEADER = [...FILE_HEADER, "Trip Opened", "Trip Closed", "Trip Status"];

export function buildActivityWorkbook(data: ActivityPayload): ExcelJS.Workbook {
  const header = EXPORT_HEADER;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Cityfurnish Auto-Reco";
  wb.created = new Date();

  const trips = [...data.trips].sort((a, b) => String(a.openedAt).localeCompare(String(b.openedAt)));
  for (const [dir, name] of [["OUT", "Outward"], ["IN", "Inward"]] as const) {
    const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.addRow(header);
    let rows = 0;
    for (const trip of trips.filter((t) => t.direction === dir)) {
      const t = {
        city: String(trip.city ?? ""), direction: String(trip.direction), driverName: (trip.driverName as string) ?? null,
        vehicleNo: String(trip.vehicleNo ?? ""), guardName: trip.guardName,
      };
      for (const it of [...trip.items].sort((a, b) => String(a.scannedAt).localeCompare(String(b.scannedAt)))) {
        const cells = fileRow(t, {
          soDisplay: (it.soDisplay as string) ?? null, ticket: (it.ticket as string) ?? null,
          customer: (it.customer as string) ?? null, jobType: (it.jobType as string) ?? null,
          itemName: (it.itemName as string) ?? null, quantity: Number(it.quantity ?? 1),
          barcode: (it.barcode as string) ?? null, serialNo: (it.serialNo as string) ?? null,
          entryMethod: String(it.entryMethod ?? ""), itemKind: String(it.itemKind ?? ""),
          notes: (it.notes as string) ?? null, lastKnown: !!it.lastKnown, taskDate: (it.taskDate as string) ?? null,
          duplicateOf: it.duplicateOf ?? null, scannedAt: String(it.scannedAt),
        }).map(safeCell);
        const row = ws.addRow([...cells, istDateTime(trip.openedAt as string), istDateTime(trip.closedAt as string), String(trip.status ?? "")]);
        // Quantity as a number, so the sheet can be summed.
        const qtyCol = FILE_HEADER.indexOf("Qty") + 1;
        row.getCell(qtyCol).value = Number(it.quantity ?? 1);
        if (it.duplicateOf) row.font = { color: { argb: "FF9A9A9A" }, italic: true };
        rows++;
      }
    }
    const head = ws.getRow(1);
    head.font = { bold: true };
    head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDEDEE" } };
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: header.length } };
    // Width from the longest value in each column, within sensible bounds.
    header.forEach((h, i) => {
      let w = h.length;
      ws.getColumn(i + 1).eachCell({ includeEmpty: false }, (c) => { w = Math.max(w, String(c.value ?? "").length); });
      ws.getColumn(i + 1).width = Math.min(Math.max(w + 2, 8), 45);
    });
    // Borders on every cell with data: the gridlines survive printing and PDF.
    ws.eachRow((r) => r.eachCell({ includeEmpty: true }, (c) => {
      c.border = { top: { style: "thin", color: { argb: "FFDDDDDF" } }, left: { style: "thin", color: { argb: "FFDDDDDF" } },
                   bottom: { style: "thin", color: { argb: "FFDDDDDF" } }, right: { style: "thin", color: { argb: "FFDDDDDF" } } };
    }));
    if (rows === 0) ws.addRow([`No ${name.toLowerCase()} items recorded on ${data.businessDate}.`]);
  }

  return wb;
}
