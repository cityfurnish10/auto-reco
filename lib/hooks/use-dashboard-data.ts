"use client";

// Client data hooks for the real dashboard — plain fetch + useEffect (no
// react-query in this project). Both hooks hit the RLS-scoped API routes, so a
// manager automatically only ever receives their own city's rows.

import { useCallback, useEffect, useRef, useState } from "react";
import type { City } from "@/lib/sample-data";
import type {
  Bucket,
  Priority,
  VarianceDB,
  VarianceSource,
  VarianceStatus,
} from "@/lib/db/schema";

export interface VarianceFilters {
  city?: City | "ALL";
  date?: string;
  // Opt out of the API's default "latest run only" scoping. Set this when a
  // query must span every business date (free-text lookups); leaving both
  // `date` and this unset would otherwise silently return one day, not all.
  allDates?: boolean;
  bucket?: Bucket | "ALL";
  source?: VarianceSource | "ALL";
  priority?: Priority | "ALL";
  /**
   * A single status, "ALL", or the pseudo-status "ACTIVE" = open + in_progress
   * — everything still needing a human, which is what a triage view wants as
   * its default. A flagged (in_progress) row is otherwise invisible under a
   * plain "open" filter.
   */
  status?: VarianceStatus | "ALL" | "ACTIVE";
  /** Exact variance_name — isolates "the 57 losses that share one cause". */
  variance?: string | "ALL";
  /** Exact responsible slug — the team a chaser would actually go talk to. */
  responsible?: string | "ALL";
  /** Exact ops type (job_type), or OPS_TYPE_NONE for rows that carry none. */
  jobType?: string | "ALL";
  /**
   * Exact closure_reason. Always pair with `status` — `dispute` writes a
   * closure_reason while the row is still in_progress, so filtering on reason
   * alone returns flagged rows that were never resolved.
   */
  closureReason?: string;
  q?: string; // free-text search: barcode / ticket / SO / product / customer
  sort?: SortKey;
  dir?: SortDir;
  page?: number;
  pageSize?: number;
}

// Mirrors the SORTS whitelist in app/api/variances/route.ts. Anything not in
// this union is ignored by the server and falls back to `date`.
export type SortKey =
  | "date"
  | "city"
  | "product"
  | "barcode"
  | "ticket"
  | "source"
  | "so"
  | "variance"
  | "responsible"
  | "jobType"
  | "priority"
  | "status"
  | "age"
  | "updated";

export type SortDir = "asc" | "desc";

interface VariancesResponse {
  data: VarianceDB[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  businessDate: string | null;
  sortDegraded?: boolean;
}

function toQuery(f: VarianceFilters): string {
  const p = new URLSearchParams();
  if (f.city && f.city !== "ALL") p.set("city", f.city);
  if (f.date) p.set("date", f.date);
  if (f.allDates) p.set("dates", "all");
  if (f.bucket && f.bucket !== "ALL") p.set("bucket", f.bucket);
  if (f.source && f.source !== "ALL") p.set("source", f.source);
  if (f.priority && f.priority !== "ALL") p.set("priority", f.priority);
  if (f.status && f.status !== "ALL") {
    p.set("status", f.status === "ACTIVE" ? "open,in_progress" : f.status);
  }
  if (f.variance && f.variance !== "ALL") p.set("variance", f.variance);
  if (f.responsible && f.responsible !== "ALL") p.set("responsible", f.responsible);
  if (f.jobType && f.jobType !== "ALL") p.set("jobType", f.jobType);
  if (f.closureReason) p.set("closureReason", f.closureReason);
  if (f.q && f.q.trim()) p.set("q", f.q.trim());
  if (f.sort) p.set("sort", f.sort);
  if (f.dir) p.set("dir", f.dir);
  p.set("page", String(f.page ?? 1));
  p.set("pageSize", String(f.pageSize ?? 25));
  return p.toString();
}

// Every row matching `filters`, not just the page on screen. Export used to map
// over the visible page, so a filtered set of 340 silently produced a 25-row
// file. Pages at the API maximum and stops at `cap` rows, reporting whether it
// hit that ceiling so the caller can say so rather than truncate quietly.
export async function fetchAllVariances(
  filters: VarianceFilters,
  cap = 10000
): Promise<{ rows: VarianceDB[]; truncated: boolean; total: number }> {
  const PAGE = 200;
  const rows: VarianceDB[] = [];
  let total = 0;
  for (let page = 1; ; page++) {
    const query = toQuery({ ...filters, page, pageSize: PAGE });
    const res = await fetch(`/api/variances?${query}`, { credentials: "same-origin" });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    const batch = (json as VariancesResponse).data ?? [];
    total = (json as VariancesResponse).total ?? total;
    rows.push(...batch);
    if (batch.length < PAGE || rows.length >= cap || rows.length >= total) break;
  }
  return { rows: rows.slice(0, cap), truncated: total > cap, total };
}

export function useVariances(filters: VarianceFilters) {
  const [rows, setRows] = useState<VarianceDB[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  // The business date the API actually applied. When the caller sends no date
  // the server resolves the latest run — this is how the UI labels the table
  // with a real date instead of an ambiguous blank.
  const [businessDate, setBusinessDate] = useState<string | null>(null);
  // True when a priority/status sort silently fell back to alphabetical because
  // migration 0011 isn't applied — the UI says so rather than showing a wrong
  // order as if it were the requested one.
  const [sortDegraded, setSortDegraded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const query = toQuery(filters);
  const seq = useRef(0);

  /* eslint-disable react-hooks/set-state-in-effect -- setLoading toggles the
     async-fetch loading state; a synchronous set here is the intended pattern. */
  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    fetch(`/api/variances?${query}`, { credentials: "same-origin" })
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
        return json as VariancesResponse;
      })
      .then((json) => {
        if (mine !== seq.current) return; // a newer request superseded this one
        setRows(json.data ?? []);
        setTotal(json.total ?? 0);
        setTotalPages(json.totalPages ?? 0);
        setBusinessDate(json.businessDate ?? null);
        setSortDegraded(!!json.sortDegraded);
      })
      .catch((e) => {
        if (mine !== seq.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setRows([]);
        setTotal(0);
        setTotalPages(0);
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  }, [query, reloadKey]);

  /* eslint-enable react-hooks/set-state-in-effect */

  const refetch = useCallback(() => setReloadKey((k) => k + 1), []);
  return { rows, total, totalPages, businessDate, sortDegraded, loading, error, refetch };
}

// ─── Facets: the variance types / owners actually present in this scope ──────
export interface Facet {
  value: string;
  count: number;
  real: number;
}

export function useVarianceFacets(scope: {
  city?: City | "ALL";
  date?: string;
  enabled?: boolean;
}) {
  const [varianceNames, setVarianceNames] = useState<Facet[]>([]);
  const [responsibles, setResponsibles] = useState<Facet[]>([]);
  const [opsTypes, setOpsTypes] = useState<Facet[]>([]);
  const seq = useRef(0);
  const key = `${scope.city ?? "ALL"}|${scope.date ?? ""}|${scope.enabled !== false}`;

  // No set-state-in-effect disable needed here: every setState below is inside
  // an async .then, never in the effect's synchronous body.
  useEffect(() => {
    if (scope.enabled === false) return;
    const mine = ++seq.current;
    const p = new URLSearchParams();
    if (scope.city && scope.city !== "ALL") p.set("city", scope.city);
    if (scope.date) p.set("date", scope.date);
    fetch(`/api/variances/facets?${p}`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (mine !== seq.current || !json) return;
        setVarianceNames(json.varianceNames ?? []);
        setResponsibles(json.responsibles ?? []);
        setOpsTypes(json.opsTypes ?? []);
      })
      // A failed facet fetch must not break the table — the filters just stay
      // empty, which reads as "no options" rather than an error state.
      .catch(() => {});
    // key covers every field read above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { varianceNames, responsibles, opsTypes };
}

// ─── Bulk actions ───────────────────────────────────────────────────────────
export interface BulkResult {
  action: VarianceAction;
  requested: number;
  updated: number;
  /** Rows RLS blocked, or that changed between render and click. */
  skipped: number;
  updatedIds: string[];
}

export async function bulkPatchVariances(
  ids: string[],
  action: VarianceAction,
  reason?: string,
  note?: string
): Promise<BulkResult> {
  const res = await fetch("/api/variances/bulk", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ ids, action, reason, note }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as BulkResult;
}

export interface CityAgg {
  city: string;
  total: number;
  open: number;
  openReal: number; // open AND bucket REAL — the loss-only "Open" count
  inProgress: number;
  pendingApproval: number;
  closed: number;
  /** Subset of `closed` parked on the Pending List rather than finished. */
  pendingList: number;
  high: number;
  medium: number;
  info: number;
  real: number;
  infoBucket: number;
  ppBox: number;
  consumable: number;
  /** Distinct directional movements for the day — the denominator. */
  movements: number;
  /** Open losses first seen more than three days ago. */
  openOver3d: number;
  /** ISO timestamp of the oldest open loss, or null when none are open. */
  oldestOpenAt: string | null;
  /** Movements only Odoo saw — no gate register, ops sheet or delivery app. */
  odooOnly: number;
  /** Movements the floor recorded that Odoo has not posted yet. */
  floorNotInOdoo: number;
  /** Movement rows in the ledger for this date; 0 means no ledger view. */
  ledgered: number;
}

export interface StatsResponse {
  run: {
    id: string;
    business_date: string;
    run_date: string | null;
    status: string;
    created_at: string;
    completed_at: string | null;
  } | null;
  usedFallbackRun: boolean;
  byCity: CityAgg[];
  overall: CityAgg;
}

export function useStats(date?: string) {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const seq = useRef(0);

  /* eslint-disable react-hooks/set-state-in-effect -- async-fetch loading toggle */
  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    fetch(`/api/stats/summary${date ? `?date=${date}` : ""}`, { credentials: "same-origin" })
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
        return json as StatsResponse;
      })
      .then((json) => {
        if (mine === seq.current) setStats(json);
      })
      .catch((e) => {
        if (mine === seq.current) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  }, [date, reloadKey]);

  /* eslint-enable react-hooks/set-state-in-effect */

  const refetch = useCallback(() => setReloadKey((k) => k + 1), []);
  return { stats, loading, error, refetch };
}

// Variance resolution lifecycle through the RLS-scoped PATCH route. Managers
// "submit"; admins "approve"/"reject" (and may close/dispute/reopen directly).
export type VarianceAction =
  | "submit"
  | "approve"
  | "reject"
  | "close"
  | "dispute"
  | "reopen";

export async function patchVariance(
  id: string,
  action: VarianceAction,
  reason?: string,
  note?: string
): Promise<void> {
  const res = await fetch(`/api/variances/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ action, reason, note }),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json.error ?? `HTTP ${res.status}`);
  }
}
