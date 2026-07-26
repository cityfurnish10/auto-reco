"use client";

// "You are not looking at the day you think you are."
//
// The stats route falls back to the most recent successful run when the
// requested date has none — which is the right behaviour, but the only signal
// was the phrase "(latest available)" rendered in the smallest grey text on the
// page, inside a sentence nobody reads twice. Every number on the dashboard
// then describes a different day than the one implied, and the most likely
// reason for the fallback is that last night's pipeline did not run at all.
//
// That is exactly the case this app exists to catch, so it gets a banner.

import { Icon } from "@/components/icon";

export function StaleRunBanner({
  showingDate,
  requestedDate,
  onClear,
}: {
  /** The business date actually being displayed. */
  showingDate: string;
  /** What the user asked for — absent when they asked for "latest". */
  requestedDate?: string;
  /** Clears the date filter, when one caused the mismatch. */
  onClear?: () => void;
}) {
  const asked = requestedDate && requestedDate !== showingDate;
  return (
    <div
      role="status"
      className="card border-l-[3px] border-l-status-warning px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-1"
    >
      <Icon name="warning" size={18} className="text-status-warning shrink-0" />
      <p className="text-sm text-text-primary">
        {asked ? (
          <>
            No reconciliation exists for <b>{requestedDate}</b> — showing{" "}
            <b>{showingDate}</b> instead.
          </>
        ) : (
          <>
            Showing <b>{showingDate}</b>, the most recent completed run.
          </>
        )}{" "}
        <span className="text-text-secondary">
          Every figure below describes that date.
        </span>
      </p>
      {asked && onClear && (
        <button onClick={onClear} className="btn btn-compact btn-secondary ml-auto">
          Show latest
        </button>
      )}
    </div>
  );
}
