// Metabase's /api/dataset silently caps a native result at 2,000 rows when the
// request carries no `constraints`. It does not error and it does not warn — it
// returns 2,000 rows and a `rows_truncated` flag, and this client's response
// type did not even declare the field, so nobody read it.
//
// It was not hypothetical. In `ingestion_logs` the maximum `rows_pulled` across
// every ODOO pull is EXACTLY 2000, sitting on it three times and never above,
// with the next-highest at 1,985 — the signature of a cap, not of demand.
// Replaying the production query per run date, five dates come back capped:
// 2026-07-20 loses 405 rows, 07-21 loses 275, 07-19 236, 08-01 40, 08-03 13.
//
// And the cap eats the worst possible half. The query ends `ORDER BY sml.date
// ASC`, so it keeps the OLDEST postings and discards the newest: on 2026-07-20
// every one of the 405 lost rows was dated the following business day — the
// late-posting evidence POSTING_DAYS_AFTER exists to fetch. The window was
// widened to catch late entries and the late entries were what got thrown away.
//
// These tests are the tripwire. They need no network: the fetch call is the
// whole contract.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runNativeSql } from "../../lib/connectors/metabase";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_URL = process.env.METABASE_URL;
const ORIGINAL_KEY = process.env.METABASE_API_KEY;

function respond(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

const table = (rows: number, truncated?: boolean) => ({
  data: {
    cols: [{ name: "barcode" }],
    rows: Array.from({ length: rows }, (_, i) => [`ITEM-${i}`]),
    ...(truncated === undefined ? {} : { rows_truncated: truncated }),
  },
});

let calls: { url: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  process.env.METABASE_URL = "https://metabase.example";
  process.env.METABASE_API_KEY = "k";
  calls = [];
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.env.METABASE_URL = ORIGINAL_URL;
  process.env.METABASE_API_KEY = ORIGINAL_KEY;
  vi.restoreAllMocks();
});

function stub(body: unknown) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return respond(body);
  }) as unknown as typeof fetch;
}

describe("the row cap", () => {
  it("asks for a ceiling on every query, or the answer is capped at 2,000", () => {
    // The bare-rows key is the operative one for a SELECT with no aggregation —
    // measured against this instance, `max-results` alone still returns 2,000.
    // Both are sent because the aggregate path reads the other.
    stub(table(3));
    return runNativeSql(5, "SELECT 1").then(() => {
      const c = calls[0].body.constraints as Record<string, number>;
      expect(c["max-results-bare-rows"]).toBeGreaterThanOrEqual(100_000);
      expect(c["max-results"]).toBeGreaterThanOrEqual(100_000);
    });
  });

  it("throws when Metabase says it cut the result short", async () => {
    // Never a warning — and note what the throw does and does not buy. It does
    // NOT stop the run: the connector error is caught upstream, the run goes
    // 'partial' and the digest still sends. What it buys is reported.O = false,
    // which disables every Odoo-blaming rung. A truncated pull returns rows, so
    // the city reads as REPORTED and the engine confidently accuses the
    // warehouse of not posting entries it cannot see. Silence about Odoo beats
    // a confident accusation built on half of it.
    stub(table(2000, true));
    await expect(runNativeSql(5, "SELECT 1")).rejects.toThrow(/truncated/i);
  });

  it("says how many rows it got and what the limit was", async () => {
    // Whoever reads this at 21:00 needs to know whether to raise the ceiling or
    // go looking for a runaway query.
    stub(table(2000, true));
    await expect(runNativeSql(5, "SELECT 1")).rejects.toThrow(/2000 rows \(limit 100000\)/);
  });

  it("passes a complete result through untouched", async () => {
    stub(table(3, false));
    const t = await runNativeSql(5, "SELECT 1");
    expect(t.rows).toHaveLength(3);
    expect(t.rows[0]).toEqual({ barcode: "ITEM-0" });
  });

  it("sends no abort signal unless a timeout was asked for", async () => {
    // The main pull deliberately has none: it is load-bearing, and a partial
    // Odoo read is worse than a slow one. Only the optional lookahead opts in.
    let sawSignal: unknown;
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      sawSignal = init.signal;
      return respond(table(1));
    }) as unknown as typeof fetch;
    await runNativeSql(5, "SELECT 1");
    expect(sawSignal).toBeUndefined();
  });

  it("attaches a timeout when one is given, and aborts on it", async () => {
    // The reconcile is a maxDuration=60 function whose cron passes already run
    // ~40s at p50. An optional query that hangs must cost itself, not the night.
    let sawSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      sawSignal = init.signal as AbortSignal;
      // Never resolves on its own — only the signal can end this.
      return new Promise<Response>((_res, rej) => {
        sawSignal!.addEventListener("abort", () => rej(sawSignal!.reason));
      });
    }) as unknown as typeof fetch;
    await expect(runNativeSql(5, "SELECT 1", 20)).rejects.toThrow();
    expect(sawSignal).toBeInstanceOf(AbortSignal);
  });

  it("treats a response with no truncation field as complete", async () => {
    // Older Metabase builds, and any future one that drops the field. Absence
    // must not read as truncation, or every run fails on an upgrade.
    stub(table(3));
    await expect(runNativeSql(5, "SELECT 1")).resolves.toMatchObject({ rows: expect.any(Array) });
  });
});
