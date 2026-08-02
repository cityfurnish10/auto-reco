// "How many are open in Delhi this week" and "show me which ones".
//
// Two tools over one filter builder, so a count and its list can never disagree
// about what they were counting.
//
// Neither exposes `priority`. Two reasons: the word is internal, and the column
// is unusable anyway — the engine stopped emitting 'Medium' but historical rows
// still carry it. Severity is expressed as the risk tier the email and the
// dashboard already share.

import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays } from "../../engine/dates";
import { TIER, VARIANCE_LABELS, labelFor } from "../../ui/variance-labels";
import { describeFlag, describeOrder, type ToolStatus } from "../grounding";
import type { ToolContext } from "./context";

export type Period =
  | "latest_day"
  | "last_7_days"
  | "last_14_days"
  | "last_30_days"
  | "still_unresolved"
  | "custom";

export type Severity = "stock_at_risk" | "record_to_fix" | "no_action_needed" | "all";
export type State = "open" | "being_worked_on" | "waiting_for_approval" | "closed" | "not_closed" | "any";

const DB_STATUS: Record<string, string> = {
  open: "open",
  being_worked_on: "in_progress",
  waiting_for_approval: "pending_approval",
  closed: "closed",
};

const TIER_OF_SEVERITY: Record<Exclude<Severity, "all">, 1 | 2 | 3> = {
  stock_at_risk: 1,
  record_to_fix: 2,
  no_action_needed: 3,
};

/**
 * Names that can reach a given tier in ANY context.
 *
 * Used only as a query pre-filter, and only ever as a SUPERSET — the exact tier
 * depends on direction, job type and the stored bucket, which the database
 * cannot evaluate. The precise filter is applied in JS afterwards. Derived from
 * the label map rather than hand-listed, so it cannot drift.
 */
function namesReachingTier(tier: 1 | 2 | 3): string[] {
  const out: string[] = [];
  for (const name of Object.keys(VARIANCE_LABELS)) {
    const contexts = [
      {},
      { direction: "IN" as const },
      { direction: "OUT" as const },
      { direction: "CROSS" as const },
      { direction: "CROSS" as const, jobType: "REPLACE" },
    ];
    if (contexts.some((c) => labelFor(name, c).tier === tier)) out.push(name);
  }
  return out;
}

export interface Window {
  from: string | null;
  to: string | null;
  label: string;
}

export function windowFor(period: Period, ctx: ToolContext, from?: string, to?: string): Window {
  const anchor = ctx.latestReconciled ?? new Date().toISOString().slice(0, 10);
  switch (period) {
    case "still_unresolved":
      return { from: null, to: null, label: "any date, still unresolved" };
    case "last_7_days":
      return { from: addDays(anchor, -6), to: anchor, label: `${addDays(anchor, -6)} to ${anchor}` };
    case "last_14_days":
      return { from: addDays(anchor, -13), to: anchor, label: `${addDays(anchor, -13)} to ${anchor}` };
    case "last_30_days":
      return { from: addDays(anchor, -29), to: anchor, label: `${addDays(anchor, -29)} to ${anchor}` };
    case "custom":
      return { from: from ?? anchor, to: to ?? anchor, label: `${from ?? anchor} to ${to ?? anchor}` };
    case "latest_day":
    default:
      return { from: anchor, to: anchor, label: anchor };
  }
}

interface Args {
  city?: string;
  period?: Period;
  dateFrom?: string;
  dateTo?: string;
  severity?: Severity;
  state?: State;
  groupBy?: "none" | "city" | "day" | "problem_type" | "team";
  limit?: number;
}

type Row = {
  city: string;
  business_date: string;
  variance_name: string;
  direction: string | null;
  job_type: string | null;
  bucket: string | null;
  status: string;
  responsible: string | null;
  note?: string | null;
  barcode?: string;
  so_number?: string | null;
  ticket_id?: string | null;
  product?: string | null;
  customer?: string | null;
  first_seen_at?: string;
};

const AGG_ROW_CAP = 5000;

function applyFilters(
  sb: SupabaseClient,
  select: string,
  args: Args,
  win: Window,
  opts: { head?: boolean } = {}
) {
  let q = sb
    .from("variances")
    .select(select, opts.head ? { count: "exact", head: true } : { count: "exact" });

  if (args.city) q = q.eq("city", args.city);
  if (win.from) q = q.gte("business_date", win.from);
  if (win.to) q = q.lte("business_date", win.to);

  const state = args.state ?? "not_closed";
  if (state === "not_closed") q = q.in("status", ["open", "in_progress", "pending_approval"]);
  else if (state !== "any") q = q.eq("status", DB_STATUS[state]);

  const severity = args.severity ?? "all";
  if (severity !== "all" && severity !== "no_action_needed") {
    // Superset only — narrowed exactly in JS. no_action_needed gets no
    // pre-filter because its superset spans both buckets and would exclude
    // nothing useful.
    q = q.in("variance_name", namesReachingTier(TIER_OF_SEVERITY[severity]));
  }
  return q;
}

const tierOfRow = (r: Row) =>
  labelFor(r.variance_name, {
    direction: (r.direction as "IN" | "OUT" | "CROSS" | null) ?? null,
    jobType: r.job_type,
    bucket: (r.bucket as "REAL" | "INFO" | null) ?? null,
    note: r.note ?? null,
  }).tier;

function guardCity(args: Args, ctx: ToolContext): string | null {
  if (args.city && !ctx.visibleCities.includes(args.city)) {
    return `You can only see ${ctx.visibleCities.join(", ") || "no cities"}.`;
  }
  return null;
}

export async function countFlaggedItems(
  sb: SupabaseClient,
  args: Args,
  ctx: ToolContext
): Promise<Record<string, unknown>> {
  const denied = guardCity(args, ctx);
  if (denied) return { status: "city_not_visible" as ToolStatus, message: denied };

  const win = windowFor(args.period ?? "latest_day", ctx, args.dateFrom, args.dateTo);
  const severity = args.severity ?? "all";

  // Stage 1 — exact total, no rows over the wire.
  const head = await applyFilters(sb, "id", args, win, { head: true });
  if (head.error) return { status: "lookup_failed" as ToolStatus, message: head.error.message };
  const supersetTotal = head.count ?? 0;

  if (supersetTotal === 0) {
    return {
      status: "found" as ToolStatus,
      total: 0,
      covers: { city: args.city ?? "all cities", dates: win.label, state: args.state ?? "not closed" },
    };
  }

  // Stage 2 — rows, so the tier split is exact and a breakdown is possible.
  // Paginated: PostgREST silently caps an un-ranged select at 1000, which is
  // what once made the KPI tiles report 169 of 555.
  if (supersetTotal > AGG_ROW_CAP) {
    return {
      status: "found" as ToolStatus,
      total: supersetTotal,
      exact: severity === "all",
      covers: { city: args.city ?? "all cities", dates: win.label, state: args.state ?? "not closed" },
      breakdownUnavailable: "range_too_large",
    };
  }

  const rows: Row[] = [];
  for (let from = 0; from < supersetTotal; from += 1000) {
    const page = await applyFilters(
      sb,
      "city, business_date, variance_name, direction, job_type, bucket, status, responsible, note",
      args,
      win
    )
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (page.error) return { status: "lookup_failed" as ToolStatus, message: page.error.message };
    rows.push(...((page.data ?? []) as unknown as Row[]));
    if (!page.data || page.data.length < 1000) break;
  }

  const matching =
    severity === "all" ? rows : rows.filter((r) => tierOfRow(r) === TIER_OF_SEVERITY[severity]);

  // Keyed by the owner-facing heading, not a camelCase field name. A model
  // reading `noActionNeeded` will quote it back verbatim — observed on live
  // data — and internal jargon in the answer defeats the whole point of
  // translating the payload in the first place.
  // ONLY WHEN THE ROW SET IS THE WHOLE DAY. When severity is anything but
  // "all", applyFilters has already narrowed the query with .in("variance_name",
  // namesReachingTier(...)) — a superset of the asked-for tier, but a strict
  // subset of everything. Tallying all three headings over those rows produces a
  // split of a restricted set and presents it as the split of the day, so the
  // two tiers the caller did not ask about read far lower than they are.
  // Withheld rather than corrected: the honest number needs a second query, and
  // an absent field is something the model can say nothing about.
  const bySeverity: Record<string, number> | undefined =
    severity === "all"
      ? (() => {
          const t: Record<string, number> = {
            [TIER[1].heading]: 0,
            [TIER[2].heading]: 0,
            [TIER[3].heading]: 0,
          };
          for (const r of rows) t[TIER[tierOfRow(r)].heading]++;
          return t;
        })()
      : undefined;

  const groupBy = args.groupBy ?? "none";
  let breakdown: { key: string; count: number }[] | undefined;
  if (groupBy !== "none") {
    const tally = new Map<string, number>();
    for (const r of matching) {
      const key =
        groupBy === "city"
          ? r.city
          : groupBy === "day"
            ? r.business_date
            : groupBy === "team"
              ? describeFlag(r).team
              : describeFlag(r).problem;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    breakdown = [...tally.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  }

  return {
    status: "found" as ToolStatus,
    total: matching.length,
    exact: true,
    covers: { city: args.city ?? "all cities", dates: win.label, state: args.state ?? "not closed" },
    // Always present, so the number reconciles with the dashboard whatever was asked.
    bySeverity,
    ...(breakdown ? { breakdown } : {}),
  };
}

export async function listFlaggedItems(
  sb: SupabaseClient,
  args: Args,
  ctx: ToolContext
): Promise<Record<string, unknown>> {
  const denied = guardCity(args, ctx);
  if (denied) return { status: "city_not_visible" as ToolStatus, message: denied };

  const win = windowFor(args.period ?? "latest_day", ctx, args.dateFrom, args.dateTo);
  const limit = Math.min(10, Math.max(1, args.limit ?? 10));
  const severity = args.severity ?? "all";

  // closure_note / submit_note / rejection_note are deliberately NOT selected:
  // staff-typed free text is the highest-value injection surface and a list
  // never needs it. closure_reason is a closed enum and would be safe.
  const res = await applyFilters(
    sb,
    "business_date, city, barcode, direction, variance_name, bucket, job_type, status," +
      " responsible, note, so_number, ticket_id, product, first_seen_at",
    args,
    win
  )
    .order("business_date", { ascending: false })
    .order("id", { ascending: true })
    // Over-fetch, because the exact tier filter runs in JS.
    .limit(limit * 4);

  if (res.error) return { status: "lookup_failed" as ToolStatus, message: res.error.message };

  const rows = (res.data ?? []) as unknown as Row[];
  const matching =
    severity === "all" ? rows : rows.filter((r) => tierOfRow(r) === TIER_OF_SEVERITY[severity]);

  return {
    status: "found" as ToolStatus,
    shown: Math.min(matching.length, limit),
    // EXACT ONLY. res.count is the count of the DB query, and when severity is
    // not "all" that query is a superset narrowed afterwards in JS — so this
    // used to report more matches than the tool could list, and the model
    // quoted the bigger number. Omitted when it cannot be trusted; `shown` is
    // always true.
    totalMatching: severity === "all" ? res.count ?? matching.length : undefined,
    covers: { city: args.city ?? "all cities", dates: win.label },
    items: matching.slice(0, limit).map((r) => {
      const f = describeFlag(r);
      return {
        date: r.business_date,
        city: r.city,
        barcode: r.barcode,
        problem: f.problem,
        severity: f.severity,
        action: f.action,
        team: f.team,
        state: f.state,
        ...describeOrder(r),
      };
    }),
  };
}
