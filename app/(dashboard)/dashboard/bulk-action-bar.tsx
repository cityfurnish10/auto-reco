"use client";

// The bar that appears once rows are selected. Docked to the bottom of the
// viewport rather than sitting above the table, so it stays reachable after
// scrolling through a long page — and on a phone it lands right above the
// thumb instead of off-screen at the top.
//
// Every action routes through a confirm that states the count and, for the
// destructive/irreversible ones, collects the reason the API requires. Bulk
// approve in particular cannot inherit the managers' per-row submit reasons
// (see app/api/variances/bulk/route.ts), so the admin supplies one and it is
// recorded on all of them — honest, rather than stamping one person's words
// onto thirty rows.

import { useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/icon";
import { Modal } from "@/components/modal";
import { errText, useToast } from "@/components/toast";
import type { SessionUser } from "@/lib/demo-auth";
import {
  bulkPatchVariances,
  type VarianceAction,
} from "@/lib/hooks/use-dashboard-data";

type BulkAction = Extract<VarianceAction, "approve" | "reject" | "close" | "submit">;

const META: Record<
  BulkAction,
  { label: string; icon: string; verb: string; needsReason: boolean; destructive?: boolean }
> = {
  approve: { label: "Approve", icon: "check_circle", verb: "approved", needsReason: true },
  reject: { label: "Reject", icon: "close", verb: "sent back", needsReason: true, destructive: true },
  close: { label: "Resolve", icon: "task_alt", verb: "resolved", needsReason: true },
  submit: { label: "Submit for approval", icon: "send", verb: "submitted", needsReason: true },
};

export default function BulkActionBar({
  ids,
  role,
  pendingApprovalCount,
  variant = "fixed",
  onClear,
  onDone,
}: {
  ids: string[];
  role: SessionUser["role"];
  /** How many of the selected rows are actually awaiting approval. */
  pendingApprovalCount: number;
  /**
   * "fixed" docks it to the viewport (pages). "inline" renders it in place,
   * for use inside a dialog footer — a viewport-fixed bar would sit on top of
   * the dialog's own pager, and it would have to out-rank the dialog's z-layer
   * while staying under the confirm it opens.
   */
  variant?: "fixed" | "inline";
  onClear: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [pending, setPending] = useState<BulkAction | null>(null);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  if (ids.length === 0) return null;
  const isAdmin = role === "ADMIN";

  function open(action: BulkAction) {
    setReason("");
    setNote("");
    setPending(action);
  }

  async function run() {
    if (!pending || !reason.trim()) return;
    setBusy(true);
    try {
      const res = await bulkPatchVariances(ids, pending, reason.trim(), note.trim() || undefined);
      const m = META[pending];
      if (res.skipped > 0) {
        // Never round a partial success up to "done" — the skipped rows are
        // still sitting there and the user needs to know.
        toast.info(`${res.updated} of ${res.requested} ${m.verb}.`, {
          detail: `${res.skipped} were skipped — they changed status or are outside your city.`,
        });
      } else {
        toast.success(`${res.updated} variance${res.updated === 1 ? "" : "s"} ${m.verb}.`);
      }
      setPending(null);
      onClear();
      onDone();
    } catch (e) {
      toast.error(`Bulk ${pending} failed — nothing was changed.`, { detail: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  const m = pending ? META[pending] : null;

  const bar = (
    <div
      role="region"
      aria-label="Bulk actions"
      className={
        variant === "fixed"
          ? // z-[105] is deliberate: above the list dialog (z-100) so it is
            // reachable there, below the detail dialog (z-110) so it doesn't
            // float over a row someone opened, and below its own confirm (120).
            "fixed inset-x-3 bottom-3 lg:left-[284px] lg:right-6 z-[105] card shadow-card-hover border border-border px-4 py-3 flex flex-wrap items-center gap-3"
          : "px-4 py-3 flex flex-wrap items-center gap-3 border-b border-border bg-accent-soft"
      }
    >
      <span className="text-sm font-semibold text-text-primary">{ids.length} selected</span>
      <button onClick={onClear} className="btn btn-compact btn-ghost">
        Clear
      </button>
      <div className="h-5 w-px bg-border hidden sm:block" />
      <div className="flex flex-wrap items-center gap-2 ml-auto">
        {isAdmin ? (
          <>
            <button
              onClick={() => open("approve")}
              disabled={pendingApprovalCount === 0}
              title={
                pendingApprovalCount === 0
                  ? "None of the selected rows are awaiting approval"
                  : `Approve the ${pendingApprovalCount} awaiting approval`
              }
              className="btn btn-compact btn-primary disabled:opacity-40"
            >
              <Icon name="check_circle" size={16} />
              Approve {pendingApprovalCount > 0 && pendingApprovalCount}
            </button>
            <button
              onClick={() => open("reject")}
              disabled={pendingApprovalCount === 0}
              title={
                pendingApprovalCount === 0
                  ? "None of the selected rows are awaiting approval"
                  : "Send these back to the manager"
              }
              className="btn btn-compact btn-secondary disabled:opacity-40"
            >
              <Icon name="close" size={16} />
              Reject
            </button>
            <button onClick={() => open("close")} className="btn btn-compact btn-secondary">
              <Icon name="task_alt" size={16} />
              Resolve
            </button>
          </>
        ) : (
          <button onClick={() => open("submit")} className="btn btn-compact btn-primary">
            <Icon name="send" size={16} />
            Submit for approval
          </button>
        )}
      </div>
    </div>
  );

  return (
    <>
      {variant === "inline"
        ? bar
        : typeof document !== "undefined" && createPortal(bar, document.body)}

      <Modal
        open={!!pending}
        onClose={() => setPending(null)}
        title={m ? `${m.label} ${ids.length} variance${ids.length === 1 ? "" : "s"}?` : ""}
        icon={m?.destructive ? "warning" : "fact_check"}
        level="confirm"
        size="md"
        mobile="center"
      >
        {m && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run();
            }}
            className="space-y-4"
          >
            <p className="text-sm text-text-secondary">
              This applies to all <b className="text-text-primary">{ids.length}</b> selected
              row{ids.length === 1 ? "" : "s"} at once.
              {pending === "approve" && (
                <>
                  {" "}
                  Each manager&rsquo;s own submitted reason cannot be carried across a batch,
                  so the reason below is recorded on every one.
                </>
              )}
            </p>

            <div>
              <label
                htmlFor="bulk-reason"
                className="block text-sm font-medium text-text-secondary mb-1.5"
              >
                Reason <span className="text-danger">*</span>
              </label>
              <input
                id="bulk-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required
                autoFocus
                placeholder={
                  pending === "reject"
                    ? "Why are these going back?"
                    : "Recorded on every row in this batch"
                }
                className="input-clean w-full"
              />
            </div>

            <div>
              <label
                htmlFor="bulk-note"
                className="block text-sm font-medium text-text-secondary mb-1.5"
              >
                Note (optional)
              </label>
              <textarea
                id="bulk-note"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="input-clean w-full h-auto p-3 resize-none"
              />
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button type="button" onClick={() => setPending(null)} className="btn btn-secondary">
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || !reason.trim()}
                className={m.destructive ? "btn btn-destructive" : "btn btn-primary"}
              >
                <Icon
                  name={busy ? "progress_activity" : "check"}
                  size={18}
                  className={busy ? "animate-spin" : ""}
                />
                {busy ? "Applying…" : `${m.label} ${ids.length}`}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
