import { beforeEach, describe, expect, it } from "vitest";
import {
  beginRequest,
  checkRateLimit,
  endRequest,
  resetRateLimit,
} from "../../lib/ai/rate-limit";

describe("rate limiting", () => {
  beforeEach(() => resetRateLimit());

  it("blocks a second concurrent request from the same user", () => {
    // The layer that matters. The pathological case is a client bug looping,
    // and a looping client keeps hitting the same warm instance — so this one
    // is effective even though the window below is per-instance.
    expect(checkRateLimit("u1").ok).toBe(true);
    beginRequest("u1");
    const second = checkRateLimit("u1");
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("concurrent");
    endRequest("u1");
    expect(checkRateLimit("u1").ok).toBe(true);
  });

  it("does not let one user's in-flight request block another", () => {
    beginRequest("u1");
    expect(checkRateLimit("u2").ok).toBe(true);
  });

  it("allows 8 in a minute and refuses the 9th", () => {
    const t = 1_000_000;
    for (let i = 0; i < 8; i++) expect(checkRateLimit("u1", t + i).ok).toBe(true);
    const blocked = checkRateLimit("u1", t + 9);
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe("per_minute");
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("lets the window slide rather than resetting on a fixed boundary", () => {
    const t = 1_000_000;
    for (let i = 0; i < 8; i++) checkRateLimit("u1", t + i);
    expect(checkRateLimit("u1", t + 30_000).ok).toBe(false);
    // Just past 60s from the oldest hit, capacity returns.
    expect(checkRateLimit("u1", t + 61_000).ok).toBe(true);
  });

  it("caps the hour as well as the minute", () => {
    let now = 1_000_000;
    let allowed = 0;
    // 70s apart: far enough that the per-minute cap never fires, close enough
    // that all 45 land inside one hour of the first. At 90s they would span 67
    // minutes and the earliest would age out before the hourly cap could bind.
    for (let i = 0; i < 45; i++) {
      if (checkRateLimit("u1", now).ok) allowed++;
      now += 70_000;
    }
    expect(allowed).toBe(40);
  });

  it("reports when it is safe to retry", () => {
    const t = 1_000_000;
    for (let i = 0; i < 8; i++) checkRateLimit("u1", t + i);
    const v = checkRateLimit("u1", t + 10_000);
    expect(v.retryAfterSec).toBeLessThanOrEqual(60);
    expect(v.retryAfterSec).toBeGreaterThan(0);
  });
});
