// The tool surface the model can reach, and the dispatcher behind it.
//
// Four tools, all read-only. That is not a limitation, it is the primary
// prompt-injection control: product names, customer names and OCR of a
// handwritten register all reach the model, so the worst achievable outcome has
// to be a wrong sentence — never a closed item, an email, or another city's
// data. Adding a write tool would give that up.
//
// There is deliberately NO free-text search tool. /api/variances string-builds
// its .or() grammar and strips %,()*\ for exactly that reason; handing a model
// an ilike channel adds a PostgREST-grammar surface and an unindexed scan for
// no capability the three data tools lack.

import type { SupabaseClient } from "@supabase/supabase-js";
import { CITIES } from "../../sample-data";
import { HELP_TOPICS, helpForTopic } from "../../help/portal-help";
import type { ToolSchema } from "../groq";
import { findBarcodeJourney } from "./barcode-journey";
import { countFlaggedItems, listFlaggedItems } from "./flagged-items";
import type { ToolContext } from "./context";

const CITY_ENUM = [...CITIES];
const PERIOD_ENUM = [
  "latest_day",
  "last_7_days",
  "last_14_days",
  "last_30_days",
  "still_unresolved",
  "custom",
];
const SEVERITY_ENUM = ["stock_at_risk", "record_to_fix", "no_action_needed", "all"];
const STATE_ENUM = ["open", "being_worked_on", "waiting_for_approval", "closed", "not_closed", "any"];

const FILTERS = {
  city: {
    type: "string",
    enum: CITY_ENUM,
    description: "Only if the user named a city. Omit to cover everything they can see.",
  },
  period: {
    type: "string",
    enum: PERIOD_ENUM,
    description:
      "still_unresolved means everything not yet closed, whatever its date. Default latest_day.",
  },
  dateFrom: { type: "string", description: "YYYY-MM-DD. Only with period=custom." },
  dateTo: { type: "string", description: "YYYY-MM-DD. Only with period=custom." },
  severity: {
    type: "string",
    enum: SEVERITY_ENUM,
    description:
      "stock_at_risk means we cannot prove where the unit is — this is what 'urgent', 'high priority' and 'critical' mean here. record_to_fix means we know where it is but a record needs correcting. Default all.",
  },
  state: {
    type: "string",
    enum: STATE_ENUM,
    description: "Default not_closed.",
  },
} as const;

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "find_barcode_journey",
      description:
        "Everything the portal holds about one unit, identified by the barcode printed on it. Use whenever the user gives a barcode or asks what happened to a unit. Returns each day the unit appears, which of the four systems recorded it, and anything flagged. Call once per barcode.",
      parameters: {
        type: "object",
        properties: {
          barcode: {
            type: "string",
            description: "The barcode exactly as the user typed it. Do not clean it up.",
          },
          city: FILTERS.city,
        },
        required: ["barcode"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "count_flagged_items",
      description:
        "How many items are flagged, for a city and a date range. Use for 'how many', 'how much', 'is it getting better'. Always returns the exact total plus the split by severity.",
      parameters: {
        type: "object",
        properties: {
          ...FILTERS,
          groupBy: {
            type: "string",
            enum: ["none", "city", "day", "problem_type", "team"],
            description: "Ask for a breakdown only if the user wants one.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_flagged_items",
      description:
        "The actual items behind a count, up to 10, worst first. Use for 'what is still open', 'show me', 'which ones'. Same filters as count_flagged_items.",
      parameters: {
        type: "object",
        properties: {
          ...FILTERS,
          limit: { type: "integer", minimum: 1, maximum: 10, description: "Default 10." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "portal_help",
      description:
        "How to use the portal itself — filtering, searching, uploading a register, exporting, approvals, or what a page shows. Answer every 'how do I' question from this tool and never from memory.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", enum: [...HELP_TOPICS] },
        },
        required: ["topic"],
      },
    },
  },
];

export type ToolName = (typeof TOOL_SCHEMAS)[number]["function"]["name"];

/**
 * Run one tool call.
 *
 * `sb` MUST be the cookie-bound client. RLS is what stops a city manager
 * reading another city, and it is enforced in Postgres — passing the admin
 * client here would silently return every city no matter what the model asked.
 * There is a test that fails if any tool module can reach lib/supabase/admin.
 */
export async function dispatchTool(
  name: string,
  rawArgs: string,
  sb: SupabaseClient,
  ctx: ToolContext,
  role: string
): Promise<unknown> {
  let args: Record<string, unknown> = {};
  if (rawArgs?.trim()) {
    try {
      args = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      // Hand it back as data, not an exception — the model recovers by retrying
      // with valid JSON, and a throw here would end the turn.
      return { error: "bad_arguments", detail: "arguments were not valid JSON" };
    }
  }

  switch (name) {
    case "find_barcode_journey":
      return findBarcodeJourney(sb, args as { barcode?: string; city?: string }, ctx);
    case "count_flagged_items":
      return countFlaggedItems(sb, args, ctx);
    case "list_flagged_items":
      return listFlaggedItems(sb, args, ctx);
    case "portal_help": {
      const entry = helpForTopic(String(args.topic ?? "dashboard"), role);
      return entry ?? { error: "unknown_topic", available: HELP_TOPICS };
    }
    default:
      return { error: "unknown_tool", available: TOOL_SCHEMAS.map((t) => t.function.name) };
  }
}
