"use client";

// The "nothing here" panel. Two states, deliberately distinguished:
//
//   • Filtered to nothing — the data exists, the filters excluded it. This is
//     recoverable, so it offers the way out rather than leaving the user to
//     work out which of six controls did it.
//   • Genuinely empty — no rows exist for this scope at all. A "clear filters"
//     button here would be a dead end, so it isn't offered.
//
// Telling them apart matters: the old copy said "No variances match the
// selected filters" even when nothing had been reconciled yet, which sends
// someone hunting through filters for data that was never there.

import { Icon, type IconName } from "@/components/icon";

export function EmptyState({
  icon = "search_off",
  title,
  detail,
  actionLabel,
  onAction,
  compact = false,
}: {
  icon?: IconName;
  title: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
  compact?: boolean;
}) {
  return (
    <div
      className={`text-center flex flex-col items-center gap-2 ${compact ? "py-10" : "py-14"}`}
    >
      <Icon name={icon} size={32} className="text-text-disabled" />
      <p className="text-sm font-medium text-text-primary">{title}</p>
      {detail && <p className="text-xs text-text-muted max-w-sm">{detail}</p>}
      {actionLabel && onAction && (
        <button onClick={onAction} className="btn btn-compact btn-secondary mt-2">
          <Icon name="filter" size={16} />
          {actionLabel}
        </button>
      )}
    </div>
  );
}
