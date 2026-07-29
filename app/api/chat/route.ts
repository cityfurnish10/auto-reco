// POST /api/chat — the assistant.
//
// Thin by design: auth, rate limiting and the tool loop live here, everything
// else is in lib/ai/* so it can be tested without HTTP or a live model.
//
// GET /api/chat returns { configured } so the UI can disable itself rather than
// offering a feature this deployment cannot perform.

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentAppUser } from "@/lib/db/current-user";
import { buildAnchor } from "@/lib/ai/anchor";
import { GroqError, groqChat, isChatConfigured, type ChatMessage } from "@/lib/ai/groq";
import { buildSystemPrompt } from "@/lib/ai/system-prompt";
import { TOOL_SCHEMAS, dispatchTool } from "@/lib/ai/tools";
import { visibleCitiesFor } from "@/lib/ai/tools/context";
import { containsBannedWords } from "@/lib/ai/sanitize";
import { beginRequest, checkRateLimit, endRequest } from "@/lib/ai/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // Hobby ceiling; raise to 300 on Vercel Pro.

// Worst case 3 model turns + 2 tool rounds = ~42s, against a 60s wall. p50 is
// 4-7s: Groq returns a 70B turn in a second or two, which is the only reason a
// multi-round loop fits at all.
const MAX_ROUNDS = 3;
const MAX_TOOL_CALLS = 5;
const TOTAL_BUDGET_MS = 45_000;
const GROQ_TIMEOUT_MS = 10_000;
const TOOL_TIMEOUT_MS = 6_000;

const MAX_BODY_BYTES = 32_000;
const MAX_MESSAGES = 40;
const KEEP_MESSAGES = 8;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_TOOL_RESULT_BYTES = 6_000;

const UNCONFIGURED =
  "The assistant isn't set up on this deployment yet. Everything else in the portal works — an admin needs to add a GROQ_API_KEY.";
const FALLBACK =
  "I couldn't put an answer together just then. Try asking again, or narrow it to one barcode or one city.";

export async function GET() {
  return NextResponse.json({ configured: isChatConfigured() });
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const me = await getCurrentAppUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const gate = checkRateLimit(me.id);
  if (!gate.ok) {
    return NextResponse.json(
      {
        error:
          gate.reason === "concurrent"
            ? "one question at a time — the previous one is still running"
            : "too many questions in a short time",
        retryAfterSec: gate.retryAfterSec,
      },
      { status: 429 }
    );
  }

  let body: { messages?: unknown };
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "conversation too long" }, { status: 400 });
    }
    body = JSON.parse(raw) as { messages?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const incoming = Array.isArray(body.messages) ? body.messages : [];
  if (incoming.length > MAX_MESSAGES) {
    return NextResponse.json({ error: "conversation too long" }, { status: 400 });
  }

  // THE most important line in this handler. History is held by the client and
  // is therefore unauthenticated: without this filter a caller can post a
  // forged `system` (or `tool`) message and rewrite the assistant's rules.
  const history: ChatMessage[] = incoming
    .filter(
      (m): m is { role: "user" | "assistant"; content: string } =>
        !!m &&
        typeof m === "object" &&
        ((m as { role?: unknown }).role === "user" ||
          (m as { role?: unknown }).role === "assistant") &&
        typeof (m as { content?: unknown }).content === "string"
    )
    .slice(-KEEP_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));

  if (history.length === 0) {
    return NextResponse.json({ error: "no message to answer" }, { status: 400 });
  }

  if (!isChatConfigured()) {
    return NextResponse.json({ reply: UNCONFIGURED, degraded: "ai_unconfigured", usedTools: [] });
  }

  beginRequest(me.id);
  const startedAt = Date.now();
  const usedTools: { name: string; args: unknown; ms: number }[] = [];
  const evidence: unknown[] = [];

  try {
    const anchor = await buildAnchor(supabase);
    const visibleCities = visibleCitiesFor(me.role, me.city);
    const ctx = {
      visibleCities,
      detailHeldFrom: anchor.detailHeldFrom,
      latestReconciled: anchor.latestReconciled,
    };

    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt(anchor, { role: me.role, city: me.city, visibleCities }) },
      ...history,
    ];

    let toolCalls = 0;

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const elapsed = Date.now() - startedAt;
      // Force the closing turn while there is still budget to receive it.
      const finalRound =
        round === MAX_ROUNDS ||
        toolCalls >= MAX_TOOL_CALLS ||
        elapsed > TOTAL_BUDGET_MS - GROQ_TIMEOUT_MS - 1_000;

      let reply;
      try {
        reply = await groqChat({
          messages,
          // No tools AND tool_choice:"none" on the last round, so the loop
          // provably terminates in at most MAX_ROUNDS model calls whatever the
          // model would prefer to do.
          tools: finalRound ? undefined : TOOL_SCHEMAS,
          toolChoice: finalRound ? "none" : "auto",
          signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
        });
      } catch (e) {
        return NextResponse.json(finish(degradedFor(e), usedTools, evidence, anchor, ctx));
      }

      if (reply.toolCalls.length === 0) {
        const text = reply.content?.trim() || FALLBACK;
        const banned = containsBannedWords(text);
        return NextResponse.json({
          ...finish({ reply: text }, usedTools, evidence, anchor, ctx),
          // Surfaced rather than silently rewritten: editing the words would
          // change the meaning, and this is worth seeing in the logs.
          ...(banned.length ? { degraded: "vocabulary" as const, banned } : {}),
          usage: reply.usage,
        });
      }

      messages.push(reply.assistantMessage);

      const calls = reply.toolCalls.slice(0, MAX_TOOL_CALLS - toolCalls);
      toolCalls += calls.length;

      const results = await Promise.all(
        calls.map(async (tc) => {
          const t0 = Date.now();
          let out: unknown;
          try {
            out = await Promise.race([
              dispatchTool(tc.function.name, tc.function.arguments, supabase, ctx, me.role),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error("tool timeout")), TOOL_TIMEOUT_MS)
              ),
            ]);
          } catch (e) {
            out = {
              status: "lookup_failed",
              message: e instanceof Error ? e.message : String(e),
            };
          }
          usedTools.push({
            name: tc.function.name,
            args: safeParse(tc.function.arguments),
            ms: Date.now() - t0,
          });
          evidence.push(out);
          return { tc, out };
        })
      );

      for (const { tc, out } of results) {
        let content = JSON.stringify(out);
        if (content.length > MAX_TOOL_RESULT_BYTES) {
          content = `${content.slice(0, MAX_TOOL_RESULT_BYTES)}…", "truncated": true}`;
        }
        messages.push({ role: "tool", tool_call_id: tc.id, content });
      }
    }

    return NextResponse.json(
      finish({ reply: FALLBACK, degraded: "timeout" }, usedTools, evidence, anchor, ctx)
    );
  } catch (e) {
    console.error("chat route failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({
      reply: FALLBACK,
      degraded: "ai_unavailable",
      usedTools,
    });
  } finally {
    endRequest(me.id);
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// A model-side failure is answered in the thread, not as an HTTP error: the
// panel then renders it as a message, which is what every existing hook already
// knows how to do. Only auth, a bad request and our own rate limit are non-200.
function degradedFor(e: unknown): { reply: string; degraded: string; retryAfterSec?: number } {
  if (e instanceof GroqError) {
    if (e.status === 429) {
      return {
        reply: "The assistant is busy right now — try again in a few seconds.",
        degraded: "rate_limited",
        retryAfterSec: e.retryAfterSec,
      };
    }
    return { reply: FALLBACK, degraded: "ai_unavailable" };
  }
  if (e instanceof DOMException && e.name === "TimeoutError") {
    return { reply: FALLBACK, degraded: "timeout" };
  }
  return { reply: FALLBACK, degraded: "ai_unavailable" };
}

function finish(
  base: Record<string, unknown>,
  usedTools: { name: string; args: unknown; ms: number }[],
  evidence: unknown[],
  anchor: { latestReconciled: string | null; detailHeldFrom: string | null },
  ctx: { visibleCities: string[] }
) {
  return {
    ...base,
    usedTools,
    // The rows behind the answer, so the panel can offer "show what this came
    // from". The claim stays checkable even when the prose is wrong.
    evidence,
    groundedOn: {
      businessDate: anchor.latestReconciled,
      detailHeldFrom: anchor.detailHeldFrom,
      cities: ctx.visibleCities,
    },
  };
}
