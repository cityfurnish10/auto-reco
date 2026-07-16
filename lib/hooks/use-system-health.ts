"use client";

// Client data layer for the System Health page — recent runs, ingestion logs,
// guard uploads, and email sends from /api/system-health (admin-only). Mirrors
// use-leaderboard.ts.

import { useCallback, useEffect, useState } from "react";

export interface RunLog {
  id: string;
  business_date: string;
  created_at: string;
  completed_at: string | null;
  status: "running" | "success" | "partial" | "failed";
  trigger: "cron" | "manual";
  triggered_by: string | null;
  total: number;
  real_count: number;
  info_count: number;
}

export interface IngestionLog {
  id: string;
  run_id: string;
  source: string;
  status: "OK" | "FAILED";
  rows_pulled: number;
  message: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface UploadLog {
  id: string;
  created_at: string;
  city: string;
  file_name: string;
  status: string;
  rows_parsed: number;
  error: string | null;
}

export interface EmailLog {
  id: string;
  created_at: string;
  kind: "digest" | "test";
  status: "sent" | "skipped" | "failed";
  recipients: string[];
  business_date: string | null;
  error: string | null;
  message_id: string | null;
}

export interface SourceHealth {
  source: string;
  status: "OK" | "FAILED" | "UNKNOWN";
  lastAt: string | null;
  rows: number | null;
  message: string | null;
  durationMs: number | null;
}

export interface SystemHealthData {
  runs: RunLog[];
  ingestion: IngestionLog[];
  uploads: UploadLog[];
  emails: EmailLog[];
  sourceHealth: SourceHealth[];
}

export function useSystemHealth() {
  const [data, setData] = useState<SystemHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  /* eslint-disable react-hooks/set-state-in-effect -- async-fetch loading toggle */
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fetch("/api/system-health", { credentials: "same-origin" })
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
        return json as SystemHealthData;
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
