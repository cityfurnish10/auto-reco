// One CSV shape for both dashboards' Export button. Previously each dashboard
// hand-rolled the same header and row mapping over the *visible page*, so a
// filtered set of 340 rows produced a 25-row file with a confident filename.
// Pair this with fetchAllVariances() — the export must describe the filter, not
// the pagination.

import type { VarianceDB } from "@/lib/db/schema";

const COLUMNS: { header: string; get: (v: VarianceDB) => string | number | null }[] = [
  { header: "Date", get: (v) => v.business_date },
  { header: "City", get: (v) => v.city },
  { header: "Direction", get: (v) => v.direction },
  { header: "Item Name", get: (v) => v.product },
  { header: "Barcode", get: (v) => v.barcode },
  { header: "Ticket ID", get: (v) => v.ticket_id },
  { header: "Source", get: (v) => v.variance_source },
  { header: "Ops Type", get: (v) => v.job_type },
  { header: "SO Number", get: (v) => v.so_number },
  { header: "Customer", get: (v) => v.customer },
  { header: "Variance", get: (v) => v.variance_name },
  { header: "Priority", get: (v) => v.priority },
  { header: "Bucket", get: (v) => v.bucket },
  { header: "Status", get: (v) => v.status },
  { header: "Note", get: (v) => v.note },
];

// RFC 4180 quoting. The old version only escaped the product column and used
// bare commas elsewhere — any variance note or customer name containing a comma
// shifted every later column by one.
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function varianceRowsToCsv(rows: VarianceDB[]): string {
  const lines = [COLUMNS.map((c) => cell(c.header)).join(",")];
  for (const v of rows) lines.push(COLUMNS.map((c) => cell(c.get(v))).join(","));
  return lines.join("\r\n");
}

export function downloadCsv(filename: string, csv: string): void {
  // The BOM is what makes Excel open a UTF-8 CSV without mangling names.
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
