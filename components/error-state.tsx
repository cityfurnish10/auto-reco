"use client";

// A read that FAILED, shown as a failure.
//
// Promoted out of app/(dashboard)/gate/gate-client.tsx, where it was written
// after a real incident: a guard WAS saved, the list query was rejected by
// PostgREST, and the screen said "No guards yet." Two identical guards were
// then created, because the operator — reasonably — believed the first had not
// landed. Migration 0025 added the uniqueness constraint that stops the
// duplicate; this component stops the lie that caused it.
//
// AN EMPTY STATE IS A CLAIM ABOUT THE DATA. AN ERROR IS A CLAIM ABOUT THE
// REQUEST. Conflating them is not a cosmetic bug on this product: the dashboard
// rendered "Everything is accounted for — No open losses for this run" beside a
// failed fetch, which tells a warehouse manager that nothing walked out of the
// building when the truth is that nobody successfully asked. For a system whose
// only job is to be trusted about missing stock, that is the most expensive
// sentence it can print.
//
// Three things every failure here does, and each is load-bearing:
//
//   NAMES THE FAILURE   "Could not load X" — not a bare exception, which reads
//                       as noise and gets scrolled past.
//   PROTECTS THE DATA   "anything saved is still there." The incident above was
//                       a WRITE that succeeded and a READ that failed; without
//                       this line the operator's next move is to redo the write.
//   OFFERS A WAY OUT    A retry, because a transient 500 is the common case and
//                       a full page reload loses every filter on the screen.

import { Icon } from "@/components/icon";

export function ErrorState({
  what,
  detail,
  onRetry,
  compact = false,
}: {
  /** What could not be read, in the operator's words: "gate activity". */
  what: string;
  /**
   * The technical detail, kept but contained. Shown in a mono block rather than
   * as prose so it reads as a diagnostic to quote at somebody, not as an
   * instruction to act on. Null when the failure carried no message.
   */
  detail?: string | null;
  /** Omitted when the caller has no way to re-run the read. */
  onRetry?: () => void;
  compact?: boolean;
}) {
  return (
    <div
      role="alert"
      className={`card border border-danger/30 space-y-2 ${compact ? "p-4" : "p-5"}`}
    >
      <div className="flex items-center gap-2 text-danger font-medium">
        <Icon name="warning" size={17} />
        Could not load {what}
      </div>
      <p className="text-sm text-text-muted">
        This is a failure to read, not an empty list — anything saved is still there.
      </p>
      {detail && (
        <code className="block text-xs bg-surface-elevated p-2 rounded-control break-all">
          {detail}
        </code>
      )}
      {onRetry && (
        <button className="btn btn-compact btn-secondary" onClick={onRetry}>
          <Icon name="refresh" size={16} />
          Try again
        </button>
      )}
    </div>
  );
}
