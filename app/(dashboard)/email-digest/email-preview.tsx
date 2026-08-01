"use client";

// Daily Email Digest — an EXACT preview of the digest (same builder + template
// the cron uses) plus a compose panel: pick recipients (To / Cc / Bcc) from the
// user roster, add an admin note, and either Send Now or Schedule a deferred
// send (e.g. 2 days later, once the variances are resolved).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import FollowUpSend from "./follow-up-send";
import { useUsers } from "@/lib/hooks/use-users";
import {
  EMPTY_RECIPIENTS,
  addRecipient,
  candidatesOf,
  listsOf,
  removeRecipient,
  seedDefaults,
  toggleSlot,
  type RecipientState,
  type Slot,
} from "@/lib/email/recipient-list";
import type { ScheduledEmailDB } from "@/lib/db/schema";

interface PreviewData {
  empty: boolean;
  date?: string;
  html?: string;
  recipients?: string[];
}

// One row of the sent-email archive (email_logs metadata for one send).
interface ArchiveRow {
  id: string;
  kind: string;
  business_date: string | null;
  status: string;
  recipients: string[];
  created_at: string;
  error?: string | null;
}

interface ArchivedView {
  id: string;
  subject: string;
  html: string;
  archived: boolean;
  createdAt: string;
  // The envelope — the email as the recipient received it, not just its body.
  to: string[];
  cc: string[];
  bcc: string[];
  messageId: string | null;
  attachments: { name: string; url: string }[];
}

// Today as an IST calendar date — the archive is bucketed by IST send day, and
// the client's local timezone must not shift the default.
const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

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

  const [recip, setRecip] = useState<RecipientState>(EMPTY_RECIPIENTS);
  // Server-persisted list: hydrate once from /api/email/recipients, then
  // autosave every change back (debounced) — so add/remove survives refresh
  // and the nightly digest goes to the same curated list.
  const [recipHydrated, setRecipHydrated] = useState(false);
  const [extraInput, setExtraInput] = useState("");
  const [notes, setNotes] = useState("");

  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [delayDays, setDelayDays] = useState(2);
  const [requireResolved, setRequireResolved] = useState(true);
  const [scheduling, setScheduling] = useState(false);
  const [scheduled, setScheduled] = useState<ScheduledEmailDB[]>([]);

  // Sent-email archive: pick an IST day → list that day's sends → view one.
  const [archiveDate, setArchiveDate] = useState(istToday);
  const [archiveList, setArchiveList] = useState<ArchiveRow[]>([]);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [viewing, setViewing] = useState<ArchivedView | null>(null);
  const [viewingLoading, setViewingLoading] = useState<string | null>(null);
  const [archiveRefresh, setArchiveRefresh] = useState(0); // bump to reload the list
  const archiveSeq = useRef(0); // stale-guard for fast date flips

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

  // Load the archive list for the picked day. The seq guard ensures a fast
  // date flip can't let an older (slower) response overwrite a newer one.
  /* eslint-disable react-hooks/set-state-in-effect -- async list fetch */
  useEffect(() => {
    const seq = ++archiveSeq.current;
    setArchiveLoading(true);
    fetch(`/api/email/archive?date=${archiveDate}`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((j) => {
        if (archiveSeq.current !== seq) return; // stale
        setArchiveList(j.data ?? []);
      })
      .catch(() => archiveSeq.current === seq && setArchiveList([]))
      .finally(() => archiveSeq.current === seq && setArchiveLoading(false));
  }, [archiveDate, archiveRefresh]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Open one sent email in the right-hand pane.
  async function openArchived(id: string) {
    setViewingLoading(id);
    try {
      const res = await fetch(`/api/email/archive/${id}`, { credentials: "same-origin" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setViewing({
        id,
        subject: json.subject ?? "",
        html: json.html ?? "",
        archived: !!json.archived,
        to: json.to ?? [],
        cc: json.cc ?? [],
        bcc: json.bcc ?? [],
        messageId: json.messageId ?? null,
        attachments: json.attachments ?? [],
        createdAt: json.createdAt ?? "",
      });
    } catch (err) {
      flash(`Could not load email: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setViewingLoading(null);
    }
  }

  // Hydrate the saved recipient list first…
  /* eslint-disable react-hooks/set-state-in-effect -- async hydrate from the saved config */
  useEffect(() => {
    let live = true;
    fetch("/api/email/recipients", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : { state: null }))
      .then((j) => {
        if (!live) return;
        if (j.state) setRecip(j.state as RecipientState);
        setRecipHydrated(true);
      })
      .catch(() => live && setRecipHydrated(true)); // offline → behave like before
    return () => {
      live = false;
    };
  }, []);

  // …then seed the env-default To set on top (skips saved removals/choices).
  useEffect(() => {
    if (!recipHydrated || !data?.recipients?.length) return;
    setRecip((prev) => seedDefaults(prev, data.recipients!));
  }, [data, recipHydrated]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Autosave (debounced) — every add / remove / slot change persists.
  useEffect(() => {
    if (!recipHydrated) return;
    const t = setTimeout(() => {
      fetch("/api/email/recipients", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ state: recip }),
      }).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [recip, recipHydrated]);

  const candidates = useMemo(
    () =>
      candidatesOf(
        recip,
        data?.recipients ?? [],
        users.filter((u) => u.status === "active" && u.email).map((u) => u.email)
      ),
    [data, users, recip]
  );

  const nameFor = (email: string) => users.find((u) => u.email === email)?.name ?? "";

  const { to: toList, cc: ccList, bcc: bccList } = listsOf(recip);

  const setSlot = (email: string, slot: Slot) =>
    setRecip((prev) => toggleSlot(prev, email, slot));

  function addExtra() {
    const res = addRecipient(recip, extraInput);
    if (res.error) {
      setToast(res.error);
      setTimeout(() => setToast(null), 4000);
      return;
    }
    setRecip(res.state);
    setExtraInput("");
  }

  const dropRecipient = (email: string) => setRecip((prev) => removeRecipient(prev, email));

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
      setArchiveRefresh((n) => n + 1); // the new send appears in "Sent emails"
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

      {/* minmax(0,1fr) lets the preview column SHRINK below its content width —
          without it the 600px email iframe forces horizontal page scroll on
          smaller screens. */}
      <div className="grid grid-cols-1 lg:grid-cols-[380px_minmax(0,1fr)] gap-6 items-start">
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
                <div key={email} className="flex flex-wrap items-center justify-between gap-2 p-2.5">
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
                          recip.slots[email] === s
                            ? "px-2 py-1 text-xs font-semibold rounded bg-accent text-on-accent uppercase"
                            : "px-2 py-1 text-xs rounded border border-border text-text-muted hover:text-text-primary uppercase"
                        }
                      >
                        {s}
                      </button>
                    ))}
                    <button
                      onClick={() => dropRecipient(email)}
                      className="btn-icon text-text-muted hover:text-danger ml-1"
                      title="Remove from recipient list"
                      aria-label={`Remove ${email} from recipient list`}
                    >
                      <Icon name="close" size={15} />
                    </button>
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
                  The daily 16:45 IST cron will send this digest for <b>{data?.date}</b> after the delay below.
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

          {/* Follow-up send — manual resend for a day once its cases are closed */}
          <FollowUpSend
            to={toList}
            cc={ccList}
            bcc={bccList}
            onDone={(message, sent) => {
              flash(message);
              if (sent) setArchiveRefresh((n) => n + 1); // appears under "Sent emails"
            }}
          />

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

          {/* Sent-email archive — pick a day, view any email that went out */}
          <section className="card p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-headline text-base text-text-primary">Sent emails</h2>
              <input
                type="date"
                value={archiveDate}
                max={istToday()}
                onChange={(e) => setArchiveDate(e.target.value)}
                className="input-clean w-40 cursor-pointer"
                title="Show emails sent on this day (kept 30 days)"
              />
            </div>
            {archiveLoading ? (
              <p className="text-xs text-text-muted py-2">Loading…</p>
            ) : archiveList.length === 0 ? (
              <p className="text-xs text-text-muted py-2">No emails sent on this day.</p>
            ) : (
              <div className="space-y-2 max-h-72 overflow-y-auto">
                {archiveList.map((m) => {
                  const clickable = m.status === "sent";
                  const selected = viewing?.id === m.id;
                  return (
                    <button
                      key={m.id}
                      onClick={() => clickable && openArchived(m.id)}
                      disabled={!clickable || viewingLoading === m.id}
                      className={`w-full text-left flex items-center justify-between gap-2 text-xs border rounded-control p-2.5 transition-colors ${
                        selected
                          ? "border-accent bg-accent-soft"
                          : "border-border"
                      } ${clickable ? "hover:border-accent cursor-pointer" : "opacity-60 cursor-default"}`}
                      title={clickable ? "View this email" : m.error ?? m.status}
                    >
                      <div className="min-w-0">
                        <p className="text-text-primary font-medium">
                          {new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          {m.business_date && <span className="text-text-muted font-normal"> · report for {m.business_date}</span>}
                        </p>
                        <p className="text-text-muted truncate">to {recipientSummary(m.recipients)}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="badge badge-suppressed uppercase">{m.kind}</span>
                        <span className={`${SLOT_STATUS[m.status] ?? "badge"} uppercase`}>
                          {viewingLoading === m.id ? "…" : m.status}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
            <p className="text-[11px] text-text-disabled">Sent emails are archived for 30 days.</p>
          </section>
        </div>

        {/* Preview / archived-email viewer */}
        <div>
          {viewing ? (
            <div className="card overflow-hidden">
              <div className="px-4 py-2.5 border-b border-border bg-surface-elevated flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
                <span className="min-w-0 truncate">
                  <b className="text-text-secondary">{viewing.subject || "Sent email"}</b>
                  {viewing.createdAt && <> · sent {new Date(viewing.createdAt).toLocaleString()}</>}
                  {!viewing.archived && (
                    <span className="text-warning"> · re-rendered from current data — may differ from the delivered email</span>
                  )}
                </span>
                <button onClick={() => setViewing(null)} className="btn btn-compact btn-secondary shrink-0">
                  <Icon name="arrow_back" size={14} /> Back to live preview
                </button>
              </div>
              {/* THE ENVELOPE. The body alone cannot answer "what was actually
                  sent" — who received it and what travelled with it are the
                  half a reader checks first. All of it was stored already. */}
              <dl className="px-4 py-3 border-b border-border text-xs grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                <dt className="text-text-muted">Subject</dt>
                <dd className="text-text-primary font-medium min-w-0 break-words">{viewing.subject || "—"}</dd>
                <dt className="text-text-muted">To</dt>
                <dd className="text-text-secondary min-w-0 break-words">{viewing.to.length ? viewing.to.join(", ") : "—"}</dd>
                {viewing.cc.length > 0 && (
                  <>
                    <dt className="text-text-muted">Cc</dt>
                    <dd className="text-text-secondary min-w-0 break-words">{viewing.cc.join(", ")}</dd>
                  </>
                )}
                {viewing.bcc.length > 0 && (
                  <>
                    <dt className="text-text-muted">Bcc</dt>
                    <dd className="text-text-secondary min-w-0 break-words">{viewing.bcc.join(", ")}</dd>
                  </>
                )}
                <dt className="text-text-muted">Attachments</dt>
                <dd className="min-w-0">
                  {viewing.attachments.length === 0 ? (
                    <span className="text-text-muted">None</span>
                  ) : (
                    <span className="flex flex-wrap gap-1.5">
                      {viewing.attachments.map((a) => (
                        <a
                          key={a.name}
                          href={a.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 border border-border rounded-control px-2 py-0.5 text-text-secondary hover:border-accent hover:text-accent transition-colors"
                          title="Open the PDF that was attached to this email"
                        >
                          <Icon name="download" size={12} />
                          {a.name}
                        </a>
                      ))}
                    </span>
                  )}
                </dd>
              </dl>
              <iframe
                title="Archived email"
                srcDoc={viewing.html}
                className="w-full block h-[65vh] min-h-[420px] lg:h-[760px]"
                style={{ border: "none", background: "#f3f4f6" }}
              />
            </div>
          ) : loading ? (
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
                className="w-full block h-[65vh] min-h-[420px] lg:h-[760px]"
                style={{ border: "none", background: "#f3f4f6" }}
              />
            </div>
          )}
        </div>
      </div>

      {toast && (
        <div className="fixed inset-x-4 bottom-4 md:inset-x-auto md:right-8 md:bottom-8 card bg-accent text-on-accent px-6 py-4 flex items-center gap-4 z-[60] shadow-card-hover">
          <div className="w-8 h-8 bg-success-soft text-success rounded-full flex items-center justify-center">
            <Icon name="check" size={18} />
          </div>
          <p className="text-sm">{toast}</p>
        </div>
      )}
    </div>
  );
}
