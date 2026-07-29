// The security-critical test.
//
// RLS is the boundary that stops a city manager reading another city, and it
// only works if every model-callable tool goes through the COOKIE-BOUND client.
// The service-role client bypasses RLS entirely: with it, auth.uid() is null,
// auth_city() returns null, and the policies stop filtering — so a single
// accidental import here would turn "which items are open in Delhi?" from a
// Mumbai manager into a full cross-city read.
//
// Mocking the module to throw is what makes that a build-time impossibility
// rather than a code-review habit.

import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error(
      "a chat tool reached createAdminClient() — that bypasses RLS and would leak every city"
    );
  },
}));

import { dispatchTool, TOOL_SCHEMAS } from "../../lib/ai/tools";
import type { ToolContext } from "../../lib/ai/tools/context";

const ctx: ToolContext = {
  visibleCities: ["MUMBAI"],
  detailHeldFrom: "2026-07-22",
  latestReconciled: "2026-07-27",
};

/** Records what was asked of the DB; returns nothing. */
function recordingClient() {
  const calls: { table: string; filters: [string, string, unknown][] }[] = [];
  const make = (table: string) => {
    const entry = { table, filters: [] as [string, string, unknown][] };
    calls.push(entry);
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of ["select", "order", "limit", "range", "in", "gte", "lte", "neq"]) {
      chain[m] = (...args: unknown[]) => {
        if (m === "in") entry.filters.push([m, String(args[0]), args[1]]);
        return self();
      };
    }
    chain.eq = (col: string, val: unknown) => {
      entry.filters.push(["eq", col, val]);
      return self();
    };
    chain.then = (res: (v: unknown) => unknown) => res({ data: [], error: null, count: 0 });
    // Any write method is a hard failure rather than a silent no-op: read-only
    // is the primary prompt-injection control, and a regex over the schema JSON
    // would not catch a handler that quietly gained an .update().
    for (const w of ["insert", "update", "upsert", "delete", "rpc"]) {
      chain[w] = () => {
        throw new Error(`a chat tool called .${w}() — every tool must be read-only`);
      };
    }
    return chain;
  };
  return { db: { from: make } as never, calls };
}

describe("chat tools never reach past RLS", () => {
  it("runs every data tool without touching the service-role client", async () => {
    for (const schema of TOOL_SCHEMAS) {
      const { db } = recordingClient();
      const args =
        schema.function.name === "find_barcode_journey"
          ? JSON.stringify({ barcode: "FU10L223020032" })
          : schema.function.name === "portal_help"
            ? JSON.stringify({ topic: "dashboard" })
            : JSON.stringify({ city: "MUMBAI" });
      // Throws if any tool module imported the admin client.
      await expect(
        dispatchTool(schema.function.name, args, db, ctx, "manager")
      ).resolves.toBeDefined();
    }
  });

  it("refuses a city the caller cannot see instead of returning an empty result", async () => {
    // RLS would return zero rows for DELHI here, and a model told to report
    // what it found would say "nothing is open in Delhi" — true of what it can
    // see, and dangerously false in the world. The tool must say so explicitly.
    const { db } = recordingClient();
    for (const tool of ["count_flagged_items", "list_flagged_items", "find_barcode_journey"]) {
      const args = JSON.stringify(
        tool === "find_barcode_journey"
          ? { barcode: "FU10L223020032", city: "DELHI" }
          : { city: "DELHI" }
      );
      const out = (await dispatchTool(tool, args, db, ctx, "manager")) as { status: string };
      expect(out.status, tool).toBe("city_not_visible");
    }
  });

  it("an admin may ask about any city", async () => {
    const { db } = recordingClient();
    const adminCtx: ToolContext = { ...ctx, visibleCities: ["DELHI", "MUMBAI", "PUNE"] };
    const out = (await dispatchTool(
      "count_flagged_items",
      JSON.stringify({ city: "DELHI" }),
      db,
      adminCtx,
      "admin"
    )) as { status: string };
    expect(out.status).not.toBe("city_not_visible");
  });
});

describe("every tool is read-only", () => {
  it("never calls a write method on the client", async () => {
    // The stub throws on insert/update/upsert/delete/rpc. This is the guarantee
    // that makes the injection surface survivable: product names, customer
    // names and OCR of a handwritten register all reach the model, so the worst
    // achievable outcome has to be a wrong sentence.
    for (const schema of TOOL_SCHEMAS) {
      const { db } = recordingClient();
      const args =
        schema.function.name === "find_barcode_journey"
          ? JSON.stringify({ barcode: "FU10L223020032" })
          : schema.function.name === "portal_help"
            ? JSON.stringify({ topic: "how_reconciliation_works" })
            : JSON.stringify({ city: "MUMBAI", period: "last_7_days" });
      await expect(
        dispatchTool(schema.function.name, args, db, ctx, "manager")
      ).resolves.toBeDefined();
    }
  });
});

describe("dispatch is total — a bad call never ends the turn", () => {
  it("returns an error object for an unknown tool", async () => {
    const { db } = recordingClient();
    const out = (await dispatchTool("drop_tables", "{}", db, ctx, "admin")) as { error: string };
    expect(out.error).toBe("unknown_tool");
  });

  it("returns an error object for malformed arguments", async () => {
    const { db } = recordingClient();
    const out = (await dispatchTool(
      "count_flagged_items",
      "{not json",
      db,
      ctx,
      "admin"
    )) as { error: string };
    expect(out.error).toBe("bad_arguments");
  });
});
