"use client";

// Daily Email Digest — an EXACT preview of the digest (same builder + template
// the cron uses) plus a compose panel: pick recipients (To / Cc / Bcc) from the
// user roster, add an admin note, and either Send Now or Schedule a deferred
// send (e.g. 2 days later, once the variances are resolved).

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/icon";
import { useUsers } from "@/lib/hooks/use-users";
import type { ScheduledEmailDB } from "@/lib/db/schema";

interface PreviewData {
  empty: boolean;
  date?: string;
  html?: string;
  recipients?: string[];
}

type Slot = "to" | "cc" | "bcc";

const SLOT_STATUS: Record<string, string> = {
  pending: "badge badge-medium",
  sending: "badge badge-info",
  sent: "badge badge-done",
  skipped: "badge badge-suppressed",
  canceled: "badge badge-suppressed",
  failed: "badge badge-high",
};

export default function EmailPreview() {
  const [data, setData] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const { users } = useUsers();

  const [slots, setSlots] = useState<Record<string, Slot | null>>({});
  const [extra, setExtra] = useState<string[]>([]);
  const [extraInput, setExtraInput] = useState("");
  const [notes, setNotes] = useState("");

  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [delayDays, setDelayDays] = useState(2);
  const [requireResolved, setRequireResolved] = useState(true);
  const [scheduling, setScheduling] = useState(false);
  const [scheduled, setScheduled] = useState<ScheduledEmailDB[]>([]);

  /* eslint-disable react-hooks/set-state-in-effect -- async-fetch loading toggle */
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fetch("/api/email/preview", { credentials: "same-origin" })
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
        return json as PreviewData;
      })
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const refreshScheduled = useCallback(() => {
    fetch("/api/email/schedule", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((j) => setScheduled(j.data ?? []))
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshScheduled();
  }, [refreshScheduled]);

  // Seed the default To set from the configured DIGEST_RECIPIENTS once loaded.
  /* eslint-disable react-hooks/set-state-in-effect -- one-time seed from fetched defaults */
  useEffect(() => {
    if (!data?.recipients?.length) return;
    setSlots((prev) => {
      const next = { ...prev };
      for (const e of data.recipients!) if (!(e in next)) next[e] = "to";
      return next;
    });
  }, [data]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const candidates = useMemo(() => {
    const set = new Set<string>();
    (data?.recipients ?? []).forEach((e) => set.add(e));
    users.filter((u) => u.status === "active" && u.email).forEach((u) => set.add(u.email));
    extra.forEach((e) => set.add(e));
    return [...set];
  }, [data, users, extra]);

  const nameFor = (email: string) => users.find((u) => u.email === email)?.name ?? "";

  const toList = Object.entries(slots).filter(([, s]) => s === "to").map(([e]) => e);
  const ccList = Object.entries(slots).filter(([, s]) => s === "cc").map(([e]) => e);
  const bccList = Object.entries(slots).filter(([, s]) => s === "bcc").map(([e]) => e);

  const setSlot = (email: string, slot: Slot) =>
    setSlots((prev) => ({ ...prev, [email]: prev[email] === slot ? null : slot }));

  function addExtra() {
    const e = extraInput.trim();
    if (!e || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) {
      setToast("Enter a valid email address.");
      setTimeout(() => setToast(null), 4000);
      return;
    }
    if (!extra.includes(e)) setExtra((prev) => [...prev, e]);
    setSlots((prev) => ({ ...prev, [e]: prev[e] ?? "to" }));
    setExtraInput("");
  }

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 6000);
  };

  async function sendNow() {
    setSending(true);
    try {
      const res = await fetch("/api/email/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ to: toList, cc: ccList, bcc: bccList, notes: notes || undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      flash(`Digest for ${json.date} sent to ${(json.recipients ?? []).join(", ")}.`);
    } catch (err) {
      flash(`Send failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSending(false);
    }
  }

  async function schedule() {
    setScheduling(true);
    try {
      const res = await fetch("/api/email/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          businessDate: data?.date,
          delayDays,
          requireResolved,
          to: toList,
          cc: ccList,
          bcc: bccList,
          notes: notes || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      flash(`Scheduled — will send around ${new Date(json.data.send_at).toLocaleString()}.`);
      setScheduleOpen(false);
      refreshScheduled();
    } catch (err) {
      flash(`Could not schedule: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setScheduling(false);
    }
  }

  async function cancelScheduled(id: string) {
    try {
      const res = await fetch(`/api/email/schedule?id=${id}`, { method: "DELETE", credentials: "same-origin" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `HTTP ${res.status}`);
      refreshScheduled();
    } catch (err) {
      flash(`Could not cancel: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const recipientSummary = (r: string[]) => (r.length ? r.join(", ") : "—");

  return (
    <div className="p-container-margin space-y-6">
      <div>
        <h1 className="font-headline text-xl text-text-primary">Daily Email Digest</h1>
        <p className="text-sm text-text-muted mt-1">
          Compose and send the reconciliation digest{data?.date ? <> for <b className="text-text-secondary">{data.date}</b></> : ""}, or schedule it to go out later once variances are resolved.
        </p>
      </div>

      {error && (
        <div className="card p-4 bg-danger-soft border border-danger/20 text-sm text-danger font-semibold">{error}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-6 items-start">
        {/* Compose panel */}
        <div className="space-y-4">
          <section className="card p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-headline text-base text-text-primary">Recipients</h2>
              <span className="text-xs text-text-muted">{toList.length} to · {ccList.length} cc · {bccList.length} bcc</span>
            </div>

            <div className="max-h-64 overflow-y-auto divide-y divide-border border border-border rounded-control">
              {candidates.length === 0 && (
                <p className="p-3 text-xs text-text-muted">No recipients yet — add one below.</p>
              )}
              {candidates.map((email) => (
                <div key={email} className="flex items-center justify-between gap-2 p-2.5">
                  <div className="min-w-0">
                    <p className="text-sm text-text-primary truncate">{nameFor(email) || email}</p>
                    {nameFor(email) && <p className="text-xs text-text-muted truncate">{email}</p>}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {(["to", "cc", "bcc"] as Slot[]).map((s) => (
                      <button
                        key={s}
                        onClick={() => setSlot(email, s)}
                        className={
                          slots[email] === s
                            ? "px-2 py-1 text-xs font-semibold rounded bg-accent text-white uppercase"
                            : "px-2 py-1 text-xs rounded border border-border text-text-muted hover:text-text-primary uppercase"
                        }
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <input
                type="email"
                value={extraInput}
                onChange={(e) => setExtraInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addExtra();
                  }
                }}
                placeholder="Add another email…"
                className="input-clean flex-1"
              />
              <button onClick={addExtra} className="btn btn-secondary">
                <Icon name="add" size={16} /> Add
              </button>
            </div>

            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1.5" htmlFor="notes">
                Note (optional) — appears in the email body
              </label>
              <textarea
                id="notes"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. Please prioritise the Delhi gate-log gaps before EOD."
                className="input-clean w-full h-auto p-3 resize-none"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                onClick={sendNow}
                disabled={sending || loading || data?.empty || toList.length === 0}
                className="btn btn-primary disabled:opacity-50"
              >
                <Icon name="send" size={18} />
                {sending ? "Sending…" : "Send Now"}
              </button>
              <button
                onClick={() => setScheduleOpen((v) => !v)}
                disabled={loading || data?.empty}
                className="btn btn-secondary disabled:opacity-50"
              >
                <Icon name="schedule" size={18} /> Schedule…
              </button>
            </div>

            {scheduleOpen && (
              <div className="rounded-control border border-border p-3 space-y-3 bg-surface-elevated">
                <p className="text-xs text-text-muted">
                  The daily 09:00 IST cron will send this digest for <b>{data?.date}</b> after the delay below.
                </p>
                <label className="flex items-center justify-between text-sm text-text-secondary">
                  Send after
                  <select
                    value={delayDays}
                    onChange={(e) => setDelayDays(Number(e.target.value))}
                    className="input-clean w-32 cursor-pointer"
                  >
                    <option value={1}>1 day</option>
                    <option value={2}>2 days</option>
                    <option value={3}>3 days</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={requireResolved}
                    onChange={(e) => setRequireResolved(e.target.checked)}
                  />
                  Only send once all REAL variances for the day are closed
                </label>
                <button onClick={schedule} disabled={scheduling || toList.length === 0} className="btn btn-primary w-full disabled:opacity-50">
                  <Icon name="send" size={18} /> {scheduling ? "Scheduling…" : "Schedule send"}
                </button>
              </div>
            )}
            {toList.length === 0 && (
              <p className="text-xs text-text-muted">Select at least one <b>To</b> recipient to send or schedule.</p>
            )}
          </section>

          {/* Scheduled sends */}
          {scheduled.length > 0 && (
            <section className="card p-4 space-y-3">
              <h2 className="font-headline text-base text-text-primary">Scheduled sends</h2>
              <div className="space-y-2">
                {scheduled.map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-2 text-xs border border-border rounded-control p-2.5">
                    <div className="min-w-0">
                      <p className="text-text-primary font-medium">{s.business_date}</p>
                      <p className="text-text-muted truncate">
                        {new Date(s.send_at).toLocaleString()} · to {recipientSummary(s.recipients)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`${SLOT_STATUS[s.status] ?? "badge"} uppercase`}>{s.status}</span>
                      {s.status === "pending" && (
                        <button onClick={() => cancelScheduled(s.id)} className="btn-icon hover:text-danger" title="Cancel">
                          <Icon name="close" size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* Preview */}
        <div>
          {loading ? (
            <div className="card p-12 text-center text-text-muted">Loading preview…</div>
          ) : data?.empty ? (
            <div className="card p-12 text-center text-text-muted">
              <Icon name="mail" size={40} className="mx-auto mb-3 opacity-40" />
              <p className="text-sm">No reconciliation run yet — the digest preview appears once a reconcile has run.</p>
            </div>
          ) : (
            <div className="card overflow-hidden">
              <div className="px-4 py-2.5 border-b border-border bg-surface-elevated flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
                <span>Preview for <b className="text-text-secondary">{data?.date}</b></span>
                <span className="uppercase tracking-wide">Exact rendered email {notes && "· note not shown in preview"}</span>
              </div>
              <iframe
                title="Email digest preview"
                srcDoc={data?.html ?? ""}
                className="w-full block"
                style={{ height: "760px", border: "none", background: "#f3f4f6" }}
              />
            </div>
          )}
        </div>
      </div>

      {toast && (
        <div className="fixed inset-x-4 bottom-4 md:inset-x-auto md:right-8 md:bottom-8 card bg-accent text-white px-6 py-4 flex items-center gap-4 z-[60] shadow-card-hover">
          <div className="w-8 h-8 bg-success-soft text-success rounded-full flex items-center justify-center">
            <Icon name="check" size={18} />
          </div>
          <p className="text-sm">{toast}</p>
        </div>
      )}
    </div>
  );
}
