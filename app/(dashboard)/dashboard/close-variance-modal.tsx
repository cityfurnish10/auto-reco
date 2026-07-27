"use client";

import { useState } from "react";
import { Icon } from "@/components/icon";
import { Modal } from "@/components/modal";
import { REASONS, REASON_HINT, type ClosureReason } from "@/lib/ui/closure-reasons";

// The reason vocabulary lives in lib/ui/closure-reasons.ts so the server routes
// can share it (this file is "use client"). Re-exported here because every
// existing call site imports ClosureReason from this module.
export {
  PENDING_LIST_REASON,
  REASONS,
  REASON_HINT,
  type ClosureReason,
} from "@/lib/ui/closure-reasons";

// Generic resolution modal — used for closing, submitting-for-approval, and
// rejecting a variance. Defaults preserve the original "close" behavior.
export default function CloseVarianceModal({
  itemName,
  itemCode,
  onConfirm,
  onCancel,
  title = "Close Variance",
  confirmLabel = "Confirm Close",
  reasonLabel = "Reason for Closure",
  notePlaceholder = "Explain the resolution or context...",
  showReason = true,
  reasonRequired = true,
}: {
  itemName: string;
  itemCode: string;
  onConfirm: (reason: ClosureReason | "", note: string) => void | Promise<void>;
  onCancel: () => void;
  title?: string;
  confirmLabel?: string;
  reasonLabel?: string;
  notePlaceholder?: string;
  showReason?: boolean;
  reasonRequired?: boolean;
}) {
  const [reason, setReason] = useState<ClosureReason | "">("");
  const [note, setNote] = useState("");
  const [processing, setProcessing] = useState(false);
  const blocked = (showReason && reasonRequired && !reason) || (!showReason && !note.trim());

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (blocked) return;
    setProcessing(true);
    try {
      await onConfirm(reason, note);
    } finally {
      setProcessing(false);
    }
  }

  // Chrome (overlay, panel, header, Escape, scroll-lock, focus trap) comes from
  // the shared primitive. level="confirm" keeps it above the variance detail
  // dialog, which is one of the places it gets launched from.
  return (
    <Modal
      open
      onClose={onCancel}
      title={title}
      level="confirm"
      size="md"
      mobile="center"
      bodyClassName="p-6"
    >
          <div className="bg-surface-elevated p-4 rounded-control border border-border flex items-center gap-4 mb-6">
            <div className="w-12 h-12 bg-surface-card border border-border flex items-center justify-center rounded-control">
              <Icon name="inventory_2" size={22} className="text-accent" />
            </div>
            <div>
              <p className="text-xs text-text-muted uppercase tracking-wider mb-0.5">Affected Item</p>
              <div className="flex items-center gap-2">
                <span className="font-headline text-base text-text-primary">{itemName || "—"}</span>
                <span className="bg-surface-card border border-border text-text-secondary text-xs px-1.5 py-0.5 rounded font-mono">
                  {itemCode}
                </span>
              </div>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            {showReason && (
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1.5" htmlFor="reason">
                  {reasonLabel} {reasonRequired && <span className="text-danger">*</span>}
                </label>
                <div className="relative">
                  <select
                    id="reason"
                    required={reasonRequired}
                    value={reason}
                    onChange={(e) => setReason(e.target.value as ClosureReason)}
                    className="input-clean w-full h-11! appearance-none cursor-pointer"
                  >
                    <option value="" disabled>Select a reason...</option>
                    {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <div className="absolute inset-y-0 right-3 flex items-center pointer-events-none">
                    <Icon name="expand_more" size={20} className="text-text-muted" />
                  </div>
                </div>
                {reason && REASON_HINT[reason] && (
                  <p className="text-xs text-text-muted mt-1.5">{REASON_HINT[reason]}</p>
                )}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1.5" htmlFor="note">
                {showReason ? "Add a note (optional)" : "Note"} {!showReason && <span className="text-danger">*</span>}
              </label>
              <textarea
                id="note"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={notePlaceholder}
                className="input-clean w-full h-auto p-3 resize-none"
              />
            </div>

            <div className="h-px bg-border my-2"></div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button type="button" onClick={onCancel} className="btn btn-secondary">Cancel</button>
              <button type="submit" disabled={processing || blocked} className="btn btn-primary">
                <Icon
                  name={processing ? "progress_activity" : "check_circle"}
                  size={18}
                  className={processing ? "animate-spin" : ""}
                />
                {processing ? "Processing..." : confirmLabel}
              </button>
            </div>
          </form>
    </Modal>
  );
}
