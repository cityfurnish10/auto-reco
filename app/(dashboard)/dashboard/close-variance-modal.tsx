"use client";

import { useState } from "react";
import { Icon } from "@/components/icon";

// Closure reasons (kept as a stable enum for the analytics breakdown).
export type ClosureReason =
  | "Data Entry Error"
  | "Transit Delay"
  | "Theft"
  | "System Glitch"
  | "Other";

const REASONS: ClosureReason[] = [
  "Data Entry Error",
  "Transit Delay",
  "Theft",
  "System Glitch",
  "Other",
];

export default function CloseVarianceModal({
  itemName,
  itemCode,
  onConfirm,
  onCancel,
}: {
  itemName: string;
  itemCode: string;
  onConfirm: (reason: ClosureReason, note: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState<ClosureReason | "">("");
  const [note, setNote] = useState("");
  const [processing, setProcessing] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason) return;
    setProcessing(true);
    try {
      await onConfirm(reason, note);
    } finally {
      setProcessing(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] bg-primary-container/40 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <section
        className="card w-full max-w-[480px] shadow-card-hover overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-border flex justify-between items-center">
          <h2 className="font-headline text-lg text-text-primary">Close Variance</h2>
          <button onClick={onCancel} className="btn-icon">
            <Icon name="close" size={20} />
          </button>
        </div>

        <div className="p-6">
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
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1.5" htmlFor="reason">
                Reason for Closure <span className="text-danger">*</span>
              </label>
              <div className="relative">
                <select
                  id="reason"
                  required
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
            </div>

            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1.5" htmlFor="note">
                Add a note (optional)
              </label>
              <textarea
                id="note"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Explain the resolution or context..."
                className="input-clean w-full h-auto p-3 resize-none"
              />
            </div>

            <div className="h-px bg-border my-2"></div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button type="button" onClick={onCancel} className="btn btn-secondary">Cancel</button>
              <button type="submit" disabled={processing || !reason} className="btn btn-primary">
                <Icon
                  name={processing ? "progress_activity" : "check_circle"}
                  size={18}
                  className={processing ? "animate-spin" : ""}
                />
                {processing ? "Processing..." : "Confirm Close"}
              </button>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}
