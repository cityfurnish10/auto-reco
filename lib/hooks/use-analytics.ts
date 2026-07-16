"use client";

// Client data layer for the Analytics page — historical accuracy series from
// /api/analytics (admin-only, service-role). Mirrors use-leaderboard.ts.

import { useCallback, useEffect, useState } from "react";

export interface DayPoint {
  date: string;
  movements: number;
  real: number;
  accuracy: number | null;
}

export interface CityAccuracy {
  city: string;
  movements: number;
  real: number;
  high: number;
  accuracy: number | null;
}

export interface AnalyticsData {
  empty: boolean;
  latestDate?: string;
  days?: DayPoint[];
  byCity?: { last7: CityAccuracy[]; last30: CityAccuracy[] };
}

export function useAnalytics() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  /* eslint-disable react-hooks/set-state-in-effect -- async-fetch loading toggle */
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fetch("/api/analytics", { credentials: "same-origin" })
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
        return json as AnalyticsData;
      })
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [reloadKey]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const refetch = useCallback(() => setReloadKey((k) => k + 1), []);
  return { data, loading, error, refetch };
}
