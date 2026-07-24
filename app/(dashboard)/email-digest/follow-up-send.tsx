"use client";

// Follow-up send — the admin's manual "resend after the cases are closed"
// email. Pick a past business day (typically yesterday), see how that day
// stands NOW (still-open vs closed — /api/stats/summary), add a note, and
// send the day's digest to the SAME saved To/Cc/Bcc as the daily mail.
// The digest is re-derived from the DB at send time (/api/email/test), so the
// per-city Open column reflects every closure made since the original send.

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon";

interface DayAgg {
  real: number;
  openReal: number;
  closed: number;
  pendingApproval: number;
}

interface DayStats {
  run: { business_date: string } | null;
  usedFallbackRun: boolean;
  overall: DayAgg;
  byCity: ({ city: string } & DayAgg)[];
}

// IST yesterday — the follow-up usually goes out the morning after the report.
const istYesterday = () =>
  new Date(Date.now() + 5.5 * 3600e3 - 86400e3).toISOString().slice(0, 10);
const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

export default function FollowUpSend({
  to,
  cc,
  bcc,
  onDone,
}: {
  to: string[];
  cc: string[];
  bcc: string[];
  // toast + refresh hook back into the page (message, sent ok?)
  onDone: (message: string, sent: boolean) => void;
}) {
  const [date, setDate] = useState(istYesterday);
  const [stats, setStats] = useState<DayStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const seq = useRef(0); // stale-guard for fast date flips

  /* eslint-disable react-hooks/set-state-in-effect -- async fetch loading toggle */
  useEffect(() => {
    const mySeq = ++seq.current;
    setStatsLoading(true);
    fetch(`/api/stats/summary?date=${date}`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (seq.current !== mySeq) return; // stale
        setStats(j);
      })
      .catch(() => seq.current === mySeq && setStats(null))
      .finally(() => seq.current === mySeq && setStatsLoading(false));
  }, [date]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // The summary API falls back to the latest run when the date has none —
  // that fallback must not let a follow-up go out claiming the wrong day.
  const hasRun = !!stats?.run && !stats.usedFallbackRun;
  const agg = hasRun ? stats!.overall : null;
  const canSend = hasRun && to.length > 0 && !sending;

  async function send() {
    if (!canSend) return;
    const summary = agg ? `${agg.closed} closed · ${agg.openReal} still open` : "";
    if (
      !window.confirm(
        `Send the follow-up report for ${date} (${summary}) to ${to.length} recipient(s) now?`
      )
    ) {
      return;
    }
    setSending(true);
    try {
      const res = await fetch("/api/email/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ date, to, cc, bcc, notes: note.trim() || undefined }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      onDone(`Follow-up for ${date} sent to ${(json.recipients ?? []).join(", ")}.`, true);
      setNote("");
    } catch (err) {
      onDone(
        `Follow-up send failed: ${err instanceof Error ? err.message : String(err)}`,
        false
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="card p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-headline text-base text-text-primary">Follow-up send</h2>
        <input
          type="date"
          value={date}
          max={istToday()}
          onChange={(e) => setDate(e.target.value)}
          disabled={sending}
          className="input-clean w-40 cursor-pointer"
          title="The business day this follow-up reports on"
        />
      </div>
      <p className="text-xs text-text-muted">
        Re-send a day&apos;s report once its cases are closed — rebuilt from the latest data, to
        the same To / Cc / Bcc as the daily digest.
      </p>

      {/* How the picked day stands right now */}
      {statsLoading ? (
        <p className="text-xs text-text-muted py-1">Checking the day&apos;s variances…</p>
      ) : !hasRun ? (
        <p className="text-xs text-warning py-1">
          No reconcile run for {date} — pick a reconciled day.
        </p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="badge badge-done">{agg!.closed} closed</span>
            <span className={agg!.openReal > 0 ? "badge badge-high" : "badge badge-done"}>
              {agg!.openReal} still open
            </span>
          </div>
          {stats!.byCity.length > 0 && (
            <p className="text-[11px] text-text-disabled leading-relaxed">
              {stats!.byCity
                .map((c) => `${c.city.slice(0, 3)} ${c.closed}✓/${c.openReal} open`)
                .join(" · ")}
            </p>
          )}
        </div>
      )}

      <textarea
        rows={2}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={sending}
        placeholder="Note for the email — e.g. All gaps from this day are now closed; see the updated Open column."
        className="input-clean w-full h-auto p-3 resize-none"
      />

      <button onClick={send} disabled={!canSend} className="btn btn-primary w-full disabled:opacity-50">
        <Icon name="forward_to_inbox" size={18} />
        {sending ? "Sending…" : `Send follow-up for ${date}`}
      </button>
      {to.length === 0 && (
        <p className="text-xs text-text-muted">
          Select at least one <b>To</b> recipient above to send.
        </p>
      )}
    </section>
  );
}
