// Groq client — one POST to an OpenAI-compatible endpoint.
//
// Plain fetch rather than groq-sdk: the whole client is below, and the SDK's
// internal retry/timeout machinery fights the elapsed-time budget the chat route
// has to control (60s Vercel Hobby wall, shared with the tool round trips).
// Node 20/22 on Vercel has native fetch and AbortSignal.timeout.

const DEFAULT_MODEL = "llama-3.3-70b-versatile";
const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

export interface GroqConfig {
  apiKey: string;
  model: string;
}

// Same two-tier shape as getSmtpConfig()/isEmailConfigured(): a nullable config
// getter, and a predicate derived from it rather than re-reading the env.
export function getGroqConfig(): GroqConfig | null {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) return null;
  return { apiKey, model: process.env.GROQ_MODEL?.trim() || DEFAULT_MODEL };
}

export function isChatConfigured(): boolean {
  return getGroqConfig() !== null;
}

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface GroqReply {
  content: string | null;
  toolCalls: ToolCall[];
  /** The assistant message verbatim, to append before the tool results. */
  assistantMessage: ChatMessage;
  usage?: { promptTokens: number; completionTokens: number };
}

export class GroqError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSec?: number
  ) {
    super(message);
    this.name = "GroqError";
  }
}

export async function groqChat(opts: {
  messages: ChatMessage[];
  tools?: ToolSchema[];
  /** "none" on the final round is what makes the loop provably terminate. */
  toolChoice?: "auto" | "none";
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}): Promise<GroqReply> {
  const cfg = getGroqConfig();
  if (!cfg) throw new GroqError("chat not configured", 500);

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: opts.messages,
      ...(opts.tools?.length ? { tools: opts.tools } : {}),
      ...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}),
      // Extraction and narration, not composition.
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 500,
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Pass Groq's own retry-after through rather than guessing; the free tier's
    // RPM limit bites well before our per-user limiter does.
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new GroqError(
      `groq ${res.status}: ${body.slice(0, 300)}`,
      res.status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined
    );
  }

  const json = (await res.json()) as {
    choices?: { message?: ChatMessage }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const message = json.choices?.[0]?.message;
  if (!message) throw new GroqError("groq returned no message", 502);

  return {
    content: message.content ?? null,
    toolCalls: message.tool_calls ?? [],
    assistantMessage: {
      role: "assistant",
      content: message.content ?? null,
      ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
    },
    usage: json.usage
      ? {
          promptTokens: json.usage.prompt_tokens ?? 0,
          completionTokens: json.usage.completion_tokens ?? 0,
        }
      : undefined,
  };
}
