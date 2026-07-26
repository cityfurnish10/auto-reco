"use client";

// Everything known about one flagged item, and — the part that matters — a
// straight answer to "why is this a variance?".
//
// The explanation has two halves. The engine's own reasoning (what pattern
// fired, who owns it, whether it was auto-downgraded) comes free with the row.
// The EVIDENCE — what each of the four systems actually recorded for this
// barcode — is fetched, and is deliberately reported as three distinct states
// per source, because "no row" and "that source never ran that night" mean
// completely different things to whoever has to chase this.

import { useState } from "react";
import { Icon } from "@/components/icon";
import { Modal } from "@/components/modal";
import { SourceBadge } from "@/components/source-badge";
import { Skeleton } from "@/components/skeleton";
import CloseVarianceModal from "./close-variance-modal";
import type { SessionUser } from "@/lib/demo-auth";
import type { SourceRowDB, VarianceDB } from "@/lib/db/schema";
import { VARIANCE_META } from "@/lib/engine/buckets";
import { patchVariance } from "@/lib/hooks/use-dashboard-data";
import {
  EVIDENCE_SOURCES,
  SOURCE_LABEL,
  useSourceRows,
  type EvidenceSource,
} from "@/lib/hooks/use-source-rows";
import {
  DIRECTION_LABEL,
  PRIORITY_BADGE,
  STATUS_BADGE,
  STATUS_LABEL,
  formatTs,
  responsibleLabel,
} from "@/lib/ui/variance-format";

function Field({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-wider text-text-muted">{label}</p>
      <p className={`text-sm text-text-primary break-words ${mono ? "font-mono" : ""}`}>
        {value || "—"}
      </p>
    </div>
  );
}

function SourceRowLine({ row }: { row: SourceRowDB }) {
  const bits = [
    row.direction,
    row.status,
    row.job_type,
    row.ticket_id && `Ticket ${row.ticket_id}`,
    row.so_number && `SO ${row.so_number}`,
  ].filter(Boolean);
  return (
    <div className="text-xs text-text-secondary border-t border-border pt-2 mt-2 first:border-0 first:pt-0 first:mt-0">
      <p className="flex flex-wrap gap-x-2 gap-y-0.5">
        {bits.map((b, i) => (
          <span key={i} className={i === 0 ? "font-semibold text-text-primary" : ""}>
            {b}
          </span>
        ))}
      </p>
      {(row.date || row.created_on) && (
        <p className="text-text-muted mt-0.5">
          {row.date && <>dated {row.date}</>}
          {row.created_on && row.created_on !== row.date && <> · recorded {row.created_on}</>}
        </p>
      )}
      {row.raw && (
        <details className="mt-1">
          <summary className="cursor-pointer text-text-muted hover:text-text-secondary">
            Raw record
          </summary>
          <pre className="mt-1 p-2 bg-surface-elevated rounded-control overflow-x-auto text-[11px] leading-relaxed">
            {JSON.stringify(row.raw, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

export default function VarianceDetailModal({
  variance: v,
  role,
  onClose,
  onChanged,
}: {
  variance: VarianceDB | null;
  role: SessionUser["role"];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<"close" | "reject" | "submit" | null>(null);

  const { bySource, coverage, loading: evidenceLoading } = useSourceRows({
    runId: v?.run_id ?? null,
    barcode: v?.barcode ?? null,
    city: v?.city ?? null,
    enabled: !!v,
  });

  if (!v) return null;

  const meta = VARIANCE_META[v.variance_name];
  const why = v.note ?? meta?.note ?? "Flagged for review.";
  const isAdmin = role === "ADMIN";
  // Every source came back empty AND none of them ingested anything for this
  // run — that's the 7-day prune window, not four missing records.
  const nothingRetained =
    !evidenceLoading && EVIDENCE_SOURCES.every((s) => coverage[s] === 0 && bySource[s].length === 0);

  async function act(action: "approve" | "dispute", label: string) {
    setBusy(true);
    try {
      await patchVariance(v!.id, action);
      onChanged();
      onClose();
    } catch (e) {
      alert(`Could not ${label}: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  }

  async function confirmAction(reason: string, note: string) {
    const action = confirming === "reject" ? "reject" : confirming === "submit" ? "submit" : "close";
    try {
      await patchVariance(
        v!.id,
        action,
        action === "reject" ? undefined : reason || undefined,
        note
      );
      setConfirming(null);
      onChanged();
      onClose();
    } catch (e) {
      alert(`Could not ${action}: ${e instanceof Error ? e.message : e}`);
    }
  }

  const actions = (
    <div className="px-6 py-3 flex flex-wrap items-center justify-end gap-2">
      {v.status === "closed" ? (
        <span className="text-xs text-text-muted mr-auto">
          Resolved {formatTs(v.closed_at)}
          {v.closure_reason ? ` · ${v.closure_reason}` : ""}
        </span>
      ) : (
        <span className="text-xs text-text-muted mr-auto">
          {responsibleLabel(v.responsible)} owns this
        </span>
      )}
      {isAdmin && v.status === "pending_approval" && (
        <>
          <button
            onClick={() => setConfirming("reject")}
            disabled={busy}
            className="btn btn-compact btn-secondary disabled:opacity-40"
          >
            Reject
          </button>
          <button
            onClick={() => act("approve", "approve")}
            disabled={busy}
            className="btn btn-compact btn-primary disabled:opacity-40"
          >
            <Icon name="check_circle" size={16} /> Approve
          </button>
        </>
      )}
      {isAdmin && (v.status === "open" || v.status === "in_progress") && (
        <>
          {v.status === "open" && (
            <button
              onClick={() => act("dispute", "flag")}
              disabled={busy}
              className="btn btn-compact btn-secondary disabled:opacity-40"
            >
              <Icon name="flag" size={16} /> Flag
            </button>
          )}
          <button
            onClick={() => setConfirming("close")}
            disabled={busy}
            className="btn btn-compact btn-primary disabled:opacity-40"
          >
            <Icon name="task_alt" size={16} /> Resolve
          </button>
        </>
      )}
      {!isAdmin && v.status !== "closed" && v.status !== "pending_approval" && (
        <button
          onClick={() => setConfirming("submit")}
          disabled={busy}
          className="btn btn-compact btn-primary disabled:opacity-40"
        >
          Submit for approval
        </button>
      )}
    </div>
  );

  return (
    <>
      <Modal
        open
        onClose={onClose}
        level="stacked"
        size="lg"
        mobile="fullscreen"
        icon="inventory_2"
        title={v.product || v.barcode}
        subtitle={`${v.city} · ${v.business_date} · ${DIRECTION_LABEL[v.direction]}`}
        footer={actions}
        bodyClassName="p-6 space-y-6"
      >
        {/* A — why this was flagged */}
        <section>
          <div className="flex flex-wrap items-center gap-2">
            <span className={PRIORITY_BADGE[v.priority]}>{v.priority}</span>
            <span className={`${STATUS_BADGE[v.status]} uppercase`}>{STATUS_LABEL[v.status]}</span>
            <span className="badge badge-suppressed">
              {v.bucket === "REAL" ? "Chase today" : "Audit only"}
            </span>
            <SourceBadge source={v.variance_source} />
          </div>
          <h3 className="font-headline text-base text-text-primary mt-3">{v.variance_name}</h3>
          <p className="text-sm text-text-secondary mt-1 leading-relaxed">{why}</p>
          {v.dampened && (
            <p className="mt-3 text-xs text-text-secondary bg-surface-elevated border border-border rounded-control p-3">
              <b>Auto-downgraded.</b> The rule ladder first rated this{" "}
              <b>{v.original_priority ?? "higher"}</b>, but this pattern is a data-hygiene gap
              rather than a stock loss, so it was relabelled INFO and kept out of the chase list.
            </p>
          )}
        </section>

        {/* B — evidence */}
        <section>
          <h4 className="font-headline text-sm text-text-primary">
            What each system recorded for this unit
          </h4>
          {nothingRetained ? (
            <p className="text-xs text-text-muted mt-2 bg-surface-elevated border border-border rounded-control p-3">
              Raw source rows for this run are no longer available — they are kept for 7 days.
              The explanation above still stands; only the underlying records have been pruned.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
                {EVIDENCE_SOURCES.map((s: EvidenceSource) => {
                  const rows = bySource[s];
                  const ingested = coverage[s] > 0;
                  return (
                    <div key={s} className="border border-border rounded-control p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-text-primary">
                          {SOURCE_LABEL[s]}
                        </span>
                        {evidenceLoading ? (
                          <Skeleton className="h-4 w-16" />
                        ) : rows.length > 0 ? (
                          <span className="badge badge-done">{rows.length} record{rows.length > 1 ? "s" : ""}</span>
                        ) : ingested ? (
                          <span className="badge badge-medium">No record</span>
                        ) : (
                          <span className="badge badge-suppressed">Not ingested</span>
                        )}
                      </div>
                      {evidenceLoading ? (
                        <div className="mt-2 space-y-1.5">
                          <Skeleton className="h-3 w-full" />
                          <Skeleton className="h-3 w-2/3" />
                        </div>
                      ) : rows.length > 0 ? (
                        <div className="mt-2">
                          {rows.map((r) => (
                            <SourceRowLine key={r.id} row={r} />
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-text-muted mt-2">
                          {ingested
                            ? "This system was working for the run but has no row for this barcode."
                            : "This system did not report at all for this run — its silence is not evidence."}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-text-disabled mt-2">
                Raw ingested records for this run. An absent record means nothing was ingested — it
                is not proof the unit did not move.
              </p>
            </>
          )}
        </section>

        {/* C — identifiers */}
        <section>
          <h4 className="font-headline text-sm text-text-primary mb-2">Item &amp; identifiers</h4>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
            <Field label="Product" value={v.product} />
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-wider text-text-muted">Barcode</p>
              <p className="text-sm text-text-primary font-mono break-all flex items-center gap-1.5">
                {v.barcode}
                <button
                  onClick={() => navigator.clipboard?.writeText(v.barcode)}
                  title="Copy barcode"
                  className="btn-icon w-6! h-6!"
                >
                  <Icon name="content_copy" size={13} />
                </button>
              </p>
            </div>
            <Field label="Ticket ID" value={v.ticket_id} />
            <Field label="SO / PO number" value={v.so_number} />
            <Field label="Customer" value={v.customer} />
            <Field label="Ops type" value={v.job_type} />
            <Field label="City" value={v.city} />
            <Field label="Direction" value={DIRECTION_LABEL[v.direction]} />
            <Field label="Business date" value={v.business_date} />
          </div>
        </section>

        {/* D — timeline */}
        <section>
          <h4 className="font-headline text-sm text-text-primary mb-2">History</h4>
          <div className="space-y-2 text-sm">
            <p className="text-text-secondary">
              <span className="text-text-muted">First detected</span> {formatTs(v.first_seen_at)}
              {v.last_seen_at !== v.first_seen_at && (
                <>
                  {" · "}
                  <span className="text-text-muted">last confirmed</span> {formatTs(v.last_seen_at)}
                </>
              )}
            </p>
            {v.submitted_at && (
              <p className="text-text-secondary">
                <span className="text-text-muted">Submitted for approval</span>{" "}
                {formatTs(v.submitted_at)}
                {(v.submit_reason || v.submit_note) && (
                  <> — {[v.submit_reason, v.submit_note].filter(Boolean).join(" · ")}</>
                )}
              </p>
            )}
            {v.rejection_note && (
              <p className="text-danger">
                <span className="text-text-muted">Sent back:</span> {v.rejection_note}
              </p>
            )}
            {v.closed_at && (
              <p className="text-text-secondary">
                <span className="text-text-muted">Resolved</span> {formatTs(v.closed_at)}
                {(v.closure_reason || v.closure_note) && (
                  <> — {[v.closure_reason, v.closure_note].filter(Boolean).join(" · ")}</>
                )}
              </p>
            )}
          </div>
        </section>
      </Modal>

      {confirming && (
        <CloseVarianceModal
          itemName={v.product ?? ""}
          itemCode={v.barcode}
          title={
            confirming === "reject"
              ? "Reject Submission"
              : confirming === "submit"
                ? "Submit for Approval"
                : "Resolve Variance"
          }
          confirmLabel={
            confirming === "reject"
              ? "Reject & send back"
              : confirming === "submit"
                ? "Submit for Approval"
                : "Resolve & Close"
          }
          showReason={confirming !== "reject"}
          reasonLabel={confirming === "submit" ? "Reason for resolution" : "Reason for closure"}
          notePlaceholder={
            confirming === "reject"
              ? "Explain why this is being sent back to the manager…"
              : "Add a comment about how this was resolved…"
          }
          onConfirm={confirmAction}
          onCancel={() => setConfirming(null)}
        />
      )}
    </>
  );
}
