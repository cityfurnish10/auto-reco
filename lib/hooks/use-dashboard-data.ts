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
  bucket?: Bucket | "ALL";
  source?: VarianceSource | "ALL";
  priority?: Priority | "ALL";
  status?: VarianceStatus | "ALL";
  page?: number;
  pageSize?: number;
}

interface VariancesResponse {
  data: VarianceDB[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

function toQuery(f: VarianceFilters): string {
  const p = new URLSearchParams();
  if (f.city && f.city !== "ALL") p.set("city", f.city);
  if (f.date) p.set("date", f.date);
  if (f.bucket && f.bucket !== "ALL") p.set("bucket", f.bucket);
  if (f.source && f.source !== "ALL") p.set("source", f.source);
  if (f.priority && f.priority !== "ALL") p.set("priority", f.priority);
  if (f.status && f.status !== "ALL") p.set("status", f.status);
  p.set("page", String(f.page ?? 1));
  p.set("pageSize", String(f.pageSize ?? 25));
  return p.toString();
}

export function useVariances(filters: VarianceFilters) {
  const [rows, setRows] = useState<VarianceDB[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
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
  return { rows, total, totalPages, loading, error, refetch };
}

export interface CityAgg {
  city: string;
  total: number;
  open: number;
  inProgress: number;
  closed: number;
  high: number;
  medium: number;
  info: number;
  real: number;
  infoBucket: number;
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

// Close / dispute / reopen a variance through the RLS-scoped PATCH route.
export async function patchVariance(
  id: string,
  action: "close" | "dispute" | "reopen",
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
