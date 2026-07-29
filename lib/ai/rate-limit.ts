// The first rate limiting in this codebase, and deliberately the simplest thing
// that works with no new infrastructure.
//
// HONEST CAVEAT, because it matters: Vercel runs N instances, so the sliding
// window below is per-instance and the true ceiling is N x the limit. Two of the
// three layers are still hard:
//
//   1. Single-flight per user  — a Set of in-flight ids. This is the layer that
//      actually matters, because the pathological case is a client bug looping,
//      and a looping client keeps hitting the same warm instance.
//   2. Sliding window          — a guardrail, per-instance, best effort.
//   3. Per-request cost ceiling — enforced in the route (max rounds, max tool
//      calls, max_tokens). Instance-independent, so it bounds worst-case spend
//      per request no matter how many instances exist.
//
// If a real quota is ever needed the zero-infrastructure upgrade is a
// chat_usage table with an insert and an hourly count — reusing Supabase rather
// than adding Redis.

const PER_MINUTE = 8;
const PER_HOUR = 40;
const MAX_TRACKED_USERS = 500;

const inFlight = new Set<string>();
const hits = new Map<string, number[]>();

export interface RateVerdict {
  ok: boolean;
  reason?: "concurrent" | "per_minute" | "per_hour";
  retryAfterSec?: number;
}

export function checkRateLimit(userId: string, now = Date.now()): RateVerdict {
  if (inFlight.has(userId)) {
    return { ok: false, reason: "concurrent", retryAfterSec: 5 };
  }

  const times = (hits.get(userId) ?? []).filter((t) => now - t < 3_600_000);
  const lastMinute = times.filter((t) => now - t < 60_000);

  if (lastMinute.length >= PER_MINUTE) {
    const oldest = Math.min(...lastMinute);
    return {
      ok: false,
      reason: "per_minute",
      retryAfterSec: Math.max(1, Math.ceil((60_000 - (now - oldest)) / 1000)),
    };
  }
  if (times.length >= PER_HOUR) {
    const oldest = Math.min(...times);
    return {
      ok: false,
      reason: "per_hour",
      retryAfterSec: Math.max(1, Math.ceil((3_600_000 - (now - oldest)) / 1000)),
    };
  }

  hits.set(userId, [...times, now]);
  // Bound the map so a long-lived instance cannot grow without limit.
  if (hits.size > MAX_TRACKED_USERS) {
    const oldestKey = hits.keys().next().value;
    if (oldestKey) hits.delete(oldestKey);
  }
  return { ok: true };
}

export function beginRequest(userId: string): void {
  inFlight.add(userId);
}

export function endRequest(userId: string): void {
  inFlight.delete(userId);
}

/** Test seam — the module holds process-wide state by design. */
export function resetRateLimit(): void {
  inFlight.clear();
  hits.clear();
}
