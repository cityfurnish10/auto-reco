"use client";

// The mandatory human-review step for OCR'd guard-register rows. Grouped by
// page (a page's Direction is set once for all its rows, but any individual
// row can still be overridden — mixed pages shouldn't happen per the
// register's format, but this is cheap insurance if one ever does). Merge/
// split covers the case where handwriting OCR wraps one entry across two
// lines or splits one line into two rows — cheaper to fix with one click than
// to force the reviewer to retype the whole row.

import { useMemo, useState } from "react";
import type { ParsedGuardRow } from "@/lib/db/schema";
import { GUARD_COLUMNS } from "@/lib/connectors/ocr/table-reconstruct";
import { Icon } from "@/components/icon";

const COLUMN_LABELS: Record<string, string> = {
  date: "Date",
  so_number: "SO Number",
  ticket_id: "Ticket ID",
  product: "Product",
  po_number: "PO Number",
  barcode: "Barcode",
  operation_type: "Operation Type",
};

interface EditableRow extends ParsedGuardRow {
  key: string; // stable client-side identity, independent of array position
}

function withKeys(rows: ParsedGuardRow[]): EditableRow[] {
  return rows.map((r, i) => ({ ...r, key: `${r.page}-${r.rowIndex}-${i}` }));
}

function emptyCells(): Record<string, string> {
  const cells: Record<string, string> = {};
  GUARD_COLUMNS.forEach((col) => (cells[col] = ""));
  return cells;
}

export default function ReviewGrid({
  initialRows,
  onSubmit,
  submitting,
}: {
  initialRows: ParsedGuardRow[];
  onSubmit: (rows: ParsedGuardRow[]) => void;
  submitting?: boolean;
}) {
  const [rows, setRows] = useState<EditableRow[]>(() => withKeys(initialRows));

  const pages = useMemo(() => {
    const byPage = new Map<number, EditableRow[]>();
    for (const r of rows) {
      const list = byPage.get(r.page) ?? [];
      list.push(r);
      byPage.set(r.page, list);
    }
    return [...byPage.entries()].sort((a, b) => a[0] - b[0]);
  }, [rows]);

  function updateCell(key: string, column: string, value: string) {
    setRows((prev) =>
      prev.map((r) => (r.key === key ? { ...r, cells: { ...r.cells, [column]: value } } : r))
    );
  }

  function setPageDirection(page: number, direction: "IN" | "OUT") {
    setRows((prev) => prev.map((r) => (r.page === page ? { ...r, direction } : r)));
  }

  function setRowDirection(key: string, direction: "IN" | "OUT") {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, direction } : r)));
  }

  function deleteRow(key: string) {
    setRows((prev) => prev.filter((r) => r.key !== key));
  }

  // Merges this row's text INTO the previous row (same page only) — fixes
  // handwriting OCR that wrapped one entry across two lines.
  function mergeUp(key: string) {
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.key === key);
      if (idx <= 0) return prev;
      const previous = prev[idx - 1];
      const current = prev[idx];
      if (previous.page !== current.page) return prev;
      const merged: Record<string, string> = {};
      GUARD_COLUMNS.forEach((col) => {
        merged[col] = [previous.cells[col], current.cells[col]].filter(Boolean).join(" ").trim();
      });
      const copy = [...prev];
      copy.splice(idx - 1, 2, { ...previous, cells: merged });
      return copy;
    });
  }

  // Inserts a blank row right after this one — reviewer redistributes text
  // between the two by hand (cheaper than any auto text-split heuristic).
  function splitAfter(key: string) {
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.key === key);
      if (idx === -1) return prev;
      const current = prev[idx];
      const newRow: EditableRow = {
        ...current,
        cells: emptyCells(),
        confidence: null,
        key: `${current.key}-split-${prev.length}`,
      };
      const copy = [...prev];
      copy.splice(idx + 1, 0, newRow);
      return copy;
    });
  }

  function addRowToPage(page: number, direction: "IN" | "OUT" | null) {
    setRows((prev) => {
      const pageRows = prev.filter((r) => r.page === page);
      const lastIdx = pageRows.length ? prev.lastIndexOf(pageRows[pageRows.length - 1]) : -1;
      const newRow: EditableRow = {
        page,
        rowIndex: pageRows.length,
        direction,
        cells: emptyCells(),
        confidence: null,
        key: `${page}-new-${prev.length}`,
      };
      const copy = [...prev];
      copy.splice(lastIdx + 1, 0, newRow);
      return copy;
    });
  }

  const totalRows = rows.length;
  const rowsMissingBarcode = rows.filter((r) => !r.cells.barcode?.trim()).length;
  const rowsMissingDirection = rows.filter((r) => !r.direction).length;
  const canSubmit = totalRows > 0 && rowsMissingDirection === 0 && rowsMissingBarcode === 0;

  return (
    <div className="space-y-6">
      {pages.map(([page, pageRows]) => {
        const pageDirection = pageRows[0]?.direction ?? null;
        return (
          <div key={page} className="card overflow-hidden">
            <div className="px-4 py-3 bg-surface-elevated border-b border-border flex items-center justify-between flex-wrap gap-3">
              <span className="text-sm font-semibold text-text-primary">Page {page}</span>
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-muted">Direction for this page:</span>
                {(["IN", "OUT"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setPageDirection(page, d)}
                    className={`btn btn-compact ${pageDirection === d ? "btn-primary" : "btn-secondary"}`}
                  >
                    {d}
                  </button>
                ))}
                {!pageDirection && <span className="badge badge-medium">Needs confirmation</span>}
              </div>
            </div>
            <p className="md:hidden px-4 py-2 text-xs text-text-muted bg-surface-elevated border-b border-border">
              This grid is best reviewed on a larger screen — scroll sideways to see all columns.
            </p>
            <div className="overflow-x-auto">
              <table className="table-clean">
                <thead>
                  <tr>
                    {GUARD_COLUMNS.map((col) => (
                      <th key={col}>{COLUMN_LABELS[col] ?? col}</th>
                    ))}
                    <th>Row Dir.</th>
                    <th>Confidence</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((row) => (
                    <tr key={row.key}>
                      {GUARD_COLUMNS.map((col) => (
                        <td key={col}>
                          <input
                            className={`input-clean h-8! text-xs w-full ${
                              col === "barcode" && !row.cells.barcode?.trim() ? "border-danger!" : ""
                            }`}
                            value={row.cells[col] ?? ""}
                            onChange={(e) => updateCell(row.key, col, e.target.value)}
                          />
                        </td>
                      ))}
                      <td>
                        <select
                          className="input-clean h-8! text-xs"
                          value={row.direction ?? ""}
                          onChange={(e) => setRowDirection(row.key, e.target.value as "IN" | "OUT")}
                        >
                          <option value="" disabled>
                            —
                          </option>
                          <option value="IN">IN</option>
                          <option value="OUT">OUT</option>
                        </select>
                      </td>
                      <td className="text-xs text-text-muted">
                        {row.confidence != null ? `${Math.round(row.confidence * 100)}%` : "—"}
                      </td>
                      <td className="text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => mergeUp(row.key)}
                          className="btn-icon"
                          title="Merge into row above (wrapped text)"
                        >
                          <span className="text-xs font-semibold">Merge ↑</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => splitAfter(row.key)}
                          className="btn-icon"
                          title="Insert a blank row after this one"
                        >
                          <span className="text-xs font-semibold">Split</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteRow(row.key)}
                          className="btn-icon hover:text-danger"
                          title="Delete row"
                        >
                          <Icon name="delete" size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {pageRows.length === 0 && (
                    <tr>
                      <td colSpan={GUARD_COLUMNS.length + 3} className="text-center py-6 text-text-muted">
                        No rows on this page.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="p-3 border-t border-border bg-surface-elevated">
              <button
                type="button"
                onClick={() => addRowToPage(page, pageDirection)}
                className="btn btn-compact btn-secondary"
              >
                Add row
              </button>
            </div>
          </div>
        );
      })}

      <div className="flex items-center justify-between p-4 card flex-wrap gap-3">
        <div className="text-sm text-text-secondary">
          {totalRows} rows
          {rowsMissingBarcode > 0 && (
            <span className="text-danger ml-2">{rowsMissingBarcode} missing barcode</span>
          )}
          {rowsMissingDirection > 0 && (
            <span className="text-danger ml-2">{rowsMissingDirection} missing direction</span>
          )}
        </div>
        <button
          type="button"
          disabled={!canSubmit || submitting}
          onClick={() => onSubmit(rows.map(({ key: _key, ...r }) => r))}
          className="btn btn-primary"
        >
          {submitting ? "Submitting…" : "Confirm & Submit"}
        </button>
      </div>
    </div>
  );
}
