"use client";

// The assistant: a floating badge bottom-right, and a slide-in drawer.
//
// Both are PORTALLED to <body> rather than rendered where they are mounted.
// The sidebar <aside> carries a `translate`, which makes it the containing
// block for any fixed descendant — anything fixed rendered inside it positions
// against an off-screen drawer on mobile. The portal escapes that, and means
// the mount point in dashboard-shell is bookkeeping rather than layout.
//
// z-index: badge 90, panel 95. Modals own 100/110/120 and toasts 130, so a
// variance dialog opened from an answer correctly covers the panel, and a toast
// still lands above everything. The bulk action bar (105) covers the badge
// while rows are selected, which is the right trade.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/icon";
import { Skeleton } from "@/components/skeleton";
import { useChat, type ChatTurn } from "@/lib/hooks/use-chat";
import { useStickyState } from "@/lib/hooks/use-sticky-state";

const SUGGESTIONS = [
  "What happened to barcode ",
  "How many units are at risk today?",
  "What's still open in my city?",
  "How do I filter by city?",
];

export function ChatLauncher({ role }: { role: string }) {
  const [open, setOpen] = useStickyState("chat.open", false);
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/chat", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : { configured: false }))
      .then((j: { configured?: boolean }) => {
        if (alive) setConfigured(!!j.configured);
      })
      .catch(() => {
        if (alive) setConfigured(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Shown even when the API key is missing. Hiding it meant the one person who
  // can fix that — an admin looking at the portal — had no way to discover the
  // feature existed. The panel says what is missing instead.
  return (
    <>
      {typeof document !== "undefined" &&
        createPortal(
          <button
            type="button"
            onClick={() => setOpen(!open)}
            // Portalled to <body> and fixed bottom-right. NOT rendered inside
            // the sidebar: that <aside> carries a `translate`, which makes it
            // the containing block for fixed children, and this would position
            // against an off-screen drawer on mobile.
            //
            // z-90 keeps it under modals (100/110/120), toasts (130) and the
            // bulk action bar (105). While rows are selected the bar covers it,
            // which is the right trade — that is a focused task, not a moment
            // for the assistant.
            className={`fixed bottom-6 right-6 z-[90] flex items-center gap-2 rounded-pill
              bg-accent text-on-accent shadow-card-hover
              px-4 h-12 sm:h-14 font-medium text-sm
              transition-all duration-200 hover:brightness-110 hover:-translate-y-0.5
              motion-reduce:transition-none motion-reduce:hover:translate-y-0
              ${open ? "opacity-0 pointer-events-none translate-y-2" : "opacity-100"}`}
            aria-label="Ask the assistant"
            aria-expanded={open}
            aria-controls="chat-panel"
          >
            <span className="relative flex items-center justify-center">
              <Icon name="assistant" className="w-5 h-5" />
              {/* A quiet "unconfigured" tell for an admin, not an alarm. */}
              {configured === false && (
                <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-status-warning" />
              )}
            </span>
            <span className="hidden sm:inline">Ask AI</span>
          </button>,
          document.body
        )}
      <ChatPanel
        open={open}
        onClose={() => setOpen(false)}
        role={role}
        configured={configured}
      />
    </>
  );
}

function ChatPanel({
  open,
  onClose,
  role,
  configured,
}: {
  open: boolean;
  onClose: () => void;
  role: string;
  configured: boolean | null;
}) {
  const { turns, loading, error, send, clear } = useChat();
  const [draft, setDraft] = useStickyState("chat.draft", "");
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns.length, loading]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function submit() {
    const text = draft.trim();
    if (!text || loading) return;
    setDraft("");
    await send(text);
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <>
      {open && (
        <div
          className="fixed inset-0 bg-black/40 z-[90] lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <aside
        id="chat-panel"
        aria-label="Assistant"
        // `invisible` when shut, not merely translated: a translated element is
        // still in the tab order, so tabbing from the header would walk focus
        // through a panel nobody can see.
        className={`fixed right-0 top-0 h-[100dvh] w-full sm:w-[420px] bg-surface-card border-l border-border shadow-xl z-[95] flex flex-col transition-transform duration-200 ${
          open ? "translate-x-0 visible" : "translate-x-full invisible"
        }`}
      >
        <header className="h-14 px-4 flex items-center justify-between border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Icon name="assistant" className="w-4 h-4 text-accent" />
            <span className="font-headline text-sm text-text-primary">Assistant</span>
          </div>
          <div className="flex items-center gap-1">
            {turns.length > 0 && (
              <button type="button" onClick={clear} className="btn btn-ghost btn-compact">
                Clear
              </button>
            )}
            <button type="button" onClick={onClose} className="btn-icon" aria-label="Close">
              <Icon name="close" className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* min-h-0 is load-bearing: without it this flex child refuses to
            shrink and the transcript never scrolls. */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 space-y-4">
          {configured === false && (
            <p className="text-xs text-text-secondary bg-surface-elevated border border-border rounded-control p-3">
              The assistant is not set up on this deployment yet. An admin needs to add a{" "}
              <code className="font-mono text-[11px]">GROQ_API_KEY</code>. Everything else in
              the portal works normally.
            </p>
          )}
          {turns.length === 0 && configured !== false && (
            <EmptyState role={role} onPick={(s) => setDraft(s)} />
          )}
          {turns.map((t, i) => (
            <Turn key={i} turn={t} />
          ))}
          {loading && (
            <div className="space-y-2" aria-live="polite">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          )}
          {error && (
            <p className="text-xs text-danger bg-danger-soft border border-border rounded-control p-3">
              {error}
            </p>
          )}
          <div ref={endRef} />
        </div>

        <div className="border-t border-border p-3 shrink-0">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
              rows={2}
              disabled={configured === false}
              placeholder={
                configured === false
                  ? "Unavailable until an API key is set"
                  : "Ask about a barcode, a city, or the portal…"
              }
              // .input-clean is a fixed 36px; a composer needs to grow.
              className="input-clean h-auto p-3 flex-1 resize-none text-sm"
              aria-label="Your question"
            />
            <button
              type="button"
              onClick={() => void submit()}
              disabled={loading || !draft.trim() || configured === false}
              className="btn btn-primary btn-compact"
            >
              Ask
            </button>
          </div>
          <p className="text-[11px] text-text-disabled mt-2">
            Answers come only from what the portal holds. It will say so when a record is
            missing rather than guess.
          </p>
        </div>
      </aside>
    </>,
    document.body
  );
}

function EmptyState({ role, onPick }: { role: string; onPick: (s: string) => void }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-text-secondary">
        Ask what happened to a unit, how many items need attention, or how to use the portal.
        {role !== "ADMIN" && " Answers cover your own warehouse."}
      </p>
      <div className="flex flex-wrap gap-2">
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" onClick={() => onPick(s)} className="chip text-left">
            {s.trim()}
          </button>
        ))}
      </div>
    </div>
  );
}

function Turn({ turn }: { turn: ChatTurn }) {
  const [showEvidence, setShowEvidence] = useState(false);
  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="bg-accent-soft text-text-primary text-sm rounded-card px-3 py-2 max-w-[85%] whitespace-pre-wrap">
          {turn.content}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <p className="text-sm text-text-primary whitespace-pre-wrap leading-relaxed">
        {turn.content}
      </p>
      {turn.degraded && turn.degraded !== "vocabulary" && (
        <p className="text-[11px] text-status-warning">
          {turn.degraded === "rate_limited"
            ? "The assistant was busy — this answer may be incomplete."
            : "The assistant had trouble finishing that one."}
        </p>
      )}
      {!!turn.usedTools?.length && (
        <>
          <button
            type="button"
            onClick={() => setShowEvidence(!showEvidence)}
            className="text-[11px] text-text-muted hover:text-accent underline"
          >
            {showEvidence ? "Hide" : "Show"} what this came from
          </button>
          {showEvidence && (
            // The rows behind the answer, so a claim stays checkable even when
            // the prose is wrong.
            <pre className="text-[10px] text-text-muted bg-surface-elevated border border-border rounded-control p-2 overflow-x-auto max-h-64">
              {JSON.stringify(turn.evidence ?? turn.usedTools, null, 1)}
            </pre>
          )}
        </>
      )}
    </div>
  );
}
