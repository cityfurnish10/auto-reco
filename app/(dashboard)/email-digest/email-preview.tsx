"use client";

// Daily Email Digest — an EXACT preview of the digest that goes out after each
// nightly reconcile. It fetches the real rendered HTML (from the same builder +
// template the cron uses, over real data) and shows it in an iframe, so the
// preview can never drift from what's actually sent. "Send Test" fires a real
// send to the configured recipients.

import { useEffect, useState } from "react";
import { Icon } from "@/components/icon";

interface PreviewData {
  empty: boolean;
  date?: string;
  html?: string;
  recipients?: string[];
}

export default function EmailPreview() {
  const [data, setData] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

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

  const recipients = (data?.recipients ?? []).join(", ") || "the configured recipients";

  async function sendTest() {
    setSending(true);
    try {
      const res = await fetch("/api/email/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setToast(`Test digest for ${json.date} sent to ${(json.recipients ?? []).join(", ")}.`);
    } catch (err) {
      setToast(`Send failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSending(false);
      setTimeout(() => setToast(null), 6000);
    }
  }

  return (
    <div className="p-container-margin">
      {/* Toolbar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="font-headline text-xl text-text-primary">Daily Email Digest</h1>
          <p className="text-sm text-text-muted mt-1">
            Exact preview of the digest sent to <b className="text-text-secondary">{recipients}</b> after the nightly 00:30 reconcile.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="chip">
            <Icon name="schedule" size={16} />
            After 00:30 reconcile
          </span>
          <button
            onClick={sendTest}
            disabled={sending || loading || data?.empty}
            className="btn btn-primary disabled:opacity-50"
          >
            <Icon name="send" size={18} />
            {sending ? "Sending…" : "Send Test"}
          </button>
        </div>
      </div>

      {error && (
        <div className="card p-4 bg-danger-soft border border-danger/20 text-sm text-danger font-semibold mb-4">
          {error}
        </div>
      )}

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
            <span>
              Preview for <b className="text-text-secondary">{data?.date}</b> · to {recipients}
            </span>
            <span className="uppercase tracking-wide">Exact rendered email</span>
          </div>
          <iframe
            title="Email digest preview"
            srcDoc={data?.html ?? ""}
            className="w-full block"
            style={{ height: "760px", border: "none", background: "#f3f4f6" }}
          />
        </div>
      )}

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
