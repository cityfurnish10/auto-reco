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

// Ops type (job_type) is stored UPPER_SNAKE by normalizeJobType — "Pickup and
// Refund" becomes PICKUP_AND_REFUND. That is the right storage form (it folds
// the four spellings of "pick up" the sources actually send) but it is not what
// an ops person calls it, so render it back to sentence case.
export const OPS_TYPE_NONE = "__NONE__";

export function opsTypeLabel(raw: string | null | undefined): string {
  if (!raw) return "—";
  if (raw === OPS_TYPE_NONE) return "No ops type";
  const words = raw.replace(/_+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// How long a variance has been open, in the shortest form that still reads.
// "6d" beats a timestamp in a table column: age is what a chaser triages on,
// and an ISO date makes you do the subtraction yourself.
export function ageLabel(firstSeen: string | null | undefined): string {
  if (!firstSeen) return "—";
  const then = new Date(firstSeen).getTime();
  if (Number.isNaN(then)) return "—";
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  return weeks < 5 ? `${weeks}w` : `${Math.floor(days / 30)}mo`;
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
