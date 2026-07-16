"use client";

// Client data layer for the City Leaderboard — fetch the 4-window ranking from
// /api/leaderboard (service-role, all cities). Mirrors use-users.ts.

import { useCallback, useEffect, useState } from "react";

export type WindowKey = "latest" | "last7" | "last30" | "overall";

export interface LeaderboardRow {
  rank: number;
  city: string;
  movements: number;
  real: number;
  high: number;
  accuracy: number | null;
  trend: "up" | "down" | "flat";
}

export interface LeaderboardWindow {
  label: string;
  from: string | null;
  to: string | null;
  cities: LeaderboardRow[];
}

export interface LeaderboardData {
  empty: boolean;
  latestDate?: string;
  windows: Record<WindowKey, LeaderboardWindow> | null;
}

export function useLeaderboard() {
  const [data, setData] = useState<LeaderboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  /* eslint-disable react-hooks/set-state-in-effect -- async-fetch loading toggle */
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fetch("/api/leaderboard", { credentials: "same-origin" })
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
        return json as LeaderboardData;
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
