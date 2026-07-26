"use client";

// A sortable <th>. Sorting is server-side (the tables are paginated, so a
// client-side sort would only reorder the 25 rows already on screen and quietly
// lie about the rest), so this just reports intent upward.

import { Icon } from "@/components/icon";
import type { SortDir, SortKey } from "@/lib/hooks/use-dashboard-data";

export interface SortState {
  key: SortKey;
  dir: SortDir;
}

// Which direction a column should start in when you first click it. Text reads
// naturally A→Z; dates, severity and recency are far more useful highest-first;
// age means "oldest unresolved", so ascending.
const FIRST_CLICK: Partial<Record<SortKey, SortDir>> = {
  city: "asc",
  product: "asc",
  barcode: "asc",
  ticket: "asc",
  so: "asc",
  source: "asc",
  variance: "asc",
  responsible: "asc",
  age: "asc",
};

export function nextSort(current: SortState, key: SortKey): SortState {
  if (current.key !== key) return { key, dir: FIRST_CLICK[key] ?? "desc" };
  return { key, dir: current.dir === "asc" ? "desc" : "asc" };
}

export function SortHeader({
  label,
  sortKey,
  state,
  onSort,
  align = "left",
  title,
}: {
  label: string;
  sortKey: SortKey;
  state: SortState;
  onSort: (next: SortState) => void;
  align?: "left" | "right" | "center";
  title?: string;
}) {
  const active = state.key === sortKey;
  return (
    <th
      // aria-sort is what tells a screen reader the table is sorted and how;
      // the arrow glyph alone conveys nothing to one.
      aria-sort={active ? (state.dir === "asc" ? "ascending" : "descending") : "none"}
      className={align === "right" ? "text-right" : align === "center" ? "text-center" : undefined}
    >
      <button
        type="button"
        onClick={() => onSort(nextSort(state, sortKey))}
        title={title ?? `Sort by ${label.toLowerCase()}`}
        className={`inline-flex items-center gap-1 group ${
          active ? "text-accent" : "hover:text-text-primary"
        }`}
      >
        <span>{label}</span>
        {/* The inactive arrow is present but faint, so the column reads as
            sortable before you hover it — a control that only appears on hover
            is invisible on touch. */}
        <Icon
          name={active && state.dir === "asc" ? "expand_less" : "expand_more"}
          size={14}
          className={active ? "" : "opacity-0 group-hover:opacity-40 transition-opacity"}
        />
      </button>
    </th>
  );
}
