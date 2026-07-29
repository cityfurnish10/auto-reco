"use client";

// Client side of the assistant. Plain fetch + useState, like every other hook
// here — no react-query, and no streaming (the route returns one JSON body).

import { useCallback, useRef, useState } from "react";
import { useStickyState } from "./use-sticky-state";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  /** Present on assistant turns: which tools ran, for the evidence disclosure. */
  usedTools?: { name: string; args: unknown; ms: number }[];
  evidence?: unknown[];
  degraded?: string;
}

export interface UseChat {
  turns: ChatTurn[];
  loading: boolean;
  error: string | null;
  send: (text: string) => Promise<void>;
  clear: () => void;
}

const GENERIC_ERROR = "Something went wrong reaching the assistant. Try again in a moment.";

export function useChat(): UseChat {
  // Sticky, not persisted: survives moving around the portal, clears on reload.
  // Same primitive the date picker uses.
  const [turns, setTurns] = useStickyState<ChatTurn[]>("chat.turns", []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const send = useCallback(
    async (text: string) => {
      const question = text.trim();
      if (!question || inFlight.current) return;
      inFlight.current = true;
      setError(null);
      setLoading(true);

      const history: ChatTurn[] = [...turns, { role: "user", content: question }];
      setTurns(history);

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: history.map((t) => ({ role: t.role, content: t.content })),
          }),
        });

        // middleware.ts 307s an unauthenticated /api/* to /login, fetch follows
        // it, and /login answers with HTML — so r.json() would throw
        // "Unexpected token '<'". The route cannot fix this; the client has to
        // notice. Excluding /api/chat from the matcher would "fix" it by
        // removing authentication.
        const isJson = res.headers.get("content-type")?.includes("application/json");
        if (res.redirected || !isJson) {
          setError("Your session has expired — reload the page to sign in again.");
          return;
        }

        const json = (await res.json()) as {
          reply?: string;
          error?: string;
          retryAfterSec?: number;
          usedTools?: ChatTurn["usedTools"];
          evidence?: unknown[];
          degraded?: string;
        };

        if (!res.ok) {
          setError(
            json.error
              ? json.retryAfterSec
                ? `${json.error} — try again in ${json.retryAfterSec}s.`
                : json.error
              : GENERIC_ERROR
          );
          return;
        }

        setTurns([
          ...history,
          {
            role: "assistant",
            content: json.reply ?? GENERIC_ERROR,
            usedTools: json.usedTools,
            evidence: json.evidence,
            degraded: json.degraded,
          },
        ]);
      } catch (e) {
        setError(e instanceof Error ? e.message : GENERIC_ERROR);
      } finally {
        inFlight.current = false;
        setLoading(false);
      }
    },
    [turns, setTurns]
  );

  const clear = useCallback(() => {
    setTurns([]);
    setError(null);
  }, [setTurns]);

  return { turns, loading, error, send, clear };
}
