// Coloured pill for a variance's implicated source — the "Source" column.
// Odoo purple · DT blue · Sheet green · Physical orange · Cross red
// (matches IMPLEMENTATION_PLAN.md §B). Theme-aware via Tailwind dark variants.
//
// The pill shows the source's NAME, not its stored code: "Guard Check", never
// "Physical". The code stays what every row and every filter is keyed on — see
// lib/ui/source-names.ts for why that separation is load bearing.

import type { VarianceSource } from "@/lib/db/schema";
import { sourceLabel } from "@/lib/ui/source-names";

const STYLES: Record<VarianceSource, string> = {
  Odoo: "bg-purple-100 text-purple-700 dark:bg-purple-500/15 dark:text-purple-300",
  DT: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  Sheet: "bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300",
  Physical: "bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300",
  Cross: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
};

export function SourceBadge({ source }: { source: VarianceSource | null }) {
  if (!source) return <span className="text-text-muted">—</span>;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${STYLES[source]}`}
    >
      {sourceLabel(source)}
    </span>
  );
}
