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
//
// THERE IS A THIRD STATE, and leaving it to each caller is what produced the
// bug this file now guards against: the read FAILED. An empty list and a failed
// request look identical from `rows.length === 0`, so every call site that
// checked only the length rendered "Everything is accounted for" over a 500.
// See components/error-state.tsx for why that sentence is the expensive one.
//
// So `error` is a REQUIRED prop whose value may be null — the same trick
// VarianceRowOut.present uses in lib/engine/types.ts. Optional would be free to
// forget, and forgetting is precisely the failure mode; required means
// `tsc --noEmit` stops at every construction site until it has answered the
// question, including any site added later by someone who never read this note.

import { Icon, type IconName } from "@/components/icon";
import { ErrorState } from "@/components/error-state";

export function EmptyState({
  error,
  what = "this list",
  onRetry,
  icon = "search_off",
  title,
  detail,
  actionLabel,
  onAction,
  compact = false,
}: {
  /**
   * The failure that produced zero rows, or null when the list is honestly
   * empty. Required, not optional — see the note above.
   */
  error: string | null | undefined;
  /** Names the failed read for ErrorState: "Could not load {what}". */
  what?: string;
  onRetry?: () => void;
  icon?: IconName;
  title: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
  compact?: boolean;
}) {
  // The error branch wins. A caller cannot render reassurance over a failed
  // read even by passing a title that claims otherwise.
  if (error) {
    return <ErrorState what={what} detail={error} onRetry={onRetry} compact={compact} />;
  }

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
