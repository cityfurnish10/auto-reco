// Shared presentation vocabulary for variances — the badge classes and human
// labels used by both dashboards and both variance modals. Previously these
// maps were duplicated verbatim in admin-dashboard.tsx and
// manager-dashboard.tsx, so a new status meant editing two files and hoping
// they stayed in sync.
//
// Class strings must stay LITERAL: Tailwind scans lib/** for class names, so a
// computed/concatenated class here would silently fail to generate CSS.

import type { OutputDirection, Priority, VarianceStatus } from "../db/schema";

export const PRIORITY_BADGE: Record<Priority, string> = {
  High: "badge badge-high",
  Medium: "badge badge-medium",
  Info: "badge badge-done",
};

export const STATUS_BADGE: Record<VarianceStatus, string> = {
  open: "badge badge-medium",
  in_progress: "badge badge-suppressed",
  pending_approval: "badge badge-info",
  closed: "badge badge-done",
};

export const STATUS_LABEL: Record<VarianceStatus, string> = {
  open: "open",
  in_progress: "in progress",
  pending_approval: "pending approval",
  closed: "closed",
};

// Direction in warehouse language rather than engine shorthand. CROSS is the
// direction-conflict layer's synthetic pairing (same unit in AND out today).
export const DIRECTION_LABEL: Record<OutputDirection, string> = {
  IN: "Inward movement",
  OUT: "Outward movement",
  CROSS: "Matched in + out pair",
};

// Engine `responsible` slugs → the team a chaser would actually go talk to.
export const RESPONSIBLE_LABEL: Record<string, string> = {
  delivery_team: "Delivery team",
  odoo_team: "Odoo team",
  warehouse_team: "Warehouse team",
  ops_team: "Ops team",
};

export function responsibleLabel(slug: string | null | undefined): string {
  if (!slug) return "—";
  return RESPONSIBLE_LABEL[slug] ?? slug.replace(/_/g, " ");
}

// Timestamp → local, readable, and never "Invalid Date" for a null column.
export function formatTs(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
