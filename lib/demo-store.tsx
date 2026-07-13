"use client";

// Shared demo data store — the stand-in for the central Supabase DB.
// State is seeded from sample-data and persisted to localStorage so a
// manager closing a variance is immediately visible on the admin dashboard
// (same browser). Supabase replaces this with real cross-user persistence.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  VARIANCES,
  PLATFORM_USERS,
  GUARD_UPLOADS,
  type VarianceRow,
  type PlatformUser,
  type GuardUpload,
  type ClosureReason,
  type City,
} from "./sample-data";
import type { MultiCityRun } from "./engine/run";
import type { VarianceRowOut } from "./engine/types";

const STORAGE_KEY = "cf-demo-store-v2";

export interface LastRunInfo {
  at: string;
  date: string;
  total: number;
  realCount: number;
  infoCount: number;
  highPriority: number;
  byVariance: Record<string, number>;
  realVariances: VarianceRowOut[];
}

interface DemoState {
  variances: VarianceRow[];
  users: PlatformUser[];
  uploads: GuardUpload[];
  lastRun?: LastRunInfo | null;
}

interface DemoStore extends DemoState {
  closeVariance: (
    id: string,
    reason: ClosureReason,
    note: string,
    closedBy: string
  ) => void;
  disputeVariance: (id: string, by: string) => void;
  addUser: (user: Omit<PlatformUser, "id" | "status">) => void;
  removeUser: (id: string) => void;
  recordGuardUpload: (
    city: City,
    fileName: string,
    uploadedBy: string
  ) => string;
  setUploadStatus: (id: string, status: GuardUpload["status"], rows?: number) => void;
  applyReconciliationRun: (run: MultiCityRun) => void;
}

const seed: DemoState = {
  variances: VARIANCES,
  users: PLATFORM_USERS,
  uploads: GUARD_UPLOADS,
  lastRun: null,
};

const DemoContext = createContext<DemoStore | null>(null);

export function DemoStoreProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<DemoState>(seed);
  // State (not a ref) so the persist effect only fires AFTER the hydrated
  // state has rendered — a ref flips too early and lets the first persist
  // clobber saved data with the seed on remount.
  const [hydrated, setHydrated] = useState(false);

  // One-time SSR-safe hydration from localStorage. A lazy useState initializer
  // can't be used here because this component is server-rendered first, where
  // localStorage is undefined — so the read must happen in an effect.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as DemoState;
        if (saved.variances && saved.users && saved.uploads) {
          setState(saved);
        }
      }
    } catch {
      // Corrupt storage — fall back to seed.
    }
    setHydrated(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage full/unavailable — demo continues in-memory.
    }
  }, [state, hydrated]);

  const closeVariance = useCallback(
    (id: string, reason: ClosureReason, note: string, closedBy: string) => {
      setState((s) => ({
        ...s,
        variances: s.variances.map((v) =>
          v.id === id
            ? {
                ...v,
                status: "CLOSED",
                closureReason: reason,
                closureNote: note,
                closedBy,
                closedAt: new Date().toISOString(),
              }
            : v
        ),
      }));
    },
    []
  );

  const disputeVariance = useCallback((id: string, by: string) => {
    setState((s) => ({
      ...s,
      variances: s.variances.map((v) =>
        v.id === id && v.status === "OPEN"
          ? { ...v, status: "DISPUTED", closureNote: `Disputed by ${by}` }
          : v
      ),
    }));
  }, []);

  const addUser = useCallback((user: Omit<PlatformUser, "id" | "status">) => {
    setState((s) => ({
      ...s,
      users: [
        ...s.users,
        {
          ...user,
          id: `USR-${String(s.users.length + 1).padStart(3, "0")}`,
          status: "ACTIVE",
        },
      ],
    }));
  }, []);

  const removeUser = useCallback((id: string) => {
    setState((s) => ({
      ...s,
      users: s.users.filter((u) => u.id !== id),
    }));
  }, []);

  const recordGuardUpload = useCallback(
    (city: City, fileName: string, uploadedBy: string) => {
      const id = `UPL-${Date.now()}`;
      const now = new Date();
      setState((s) => ({
        ...s,
        uploads: [
          {
            id,
            city,
            date: now.toISOString().slice(0, 10),
            fileName,
            status: "UPLOADED",
            uploadedBy,
            time: now.toLocaleTimeString("en-IN", {
              hour: "2-digit",
              minute: "2-digit",
            }),
          },
          ...s.uploads,
        ],
      }));
      return id;
    },
    []
  );

  const setUploadStatus = useCallback(
    (id: string, status: GuardUpload["status"], rows?: number) => {
      setState((s) => ({
        ...s,
        uploads: s.uploads.map((u) =>
          u.id === id ? { ...u, status, rows: rows ?? u.rows } : u
        ),
      }));
    },
    []
  );

  const applyReconciliationRun = useCallback((run: MultiCityRun) => {
    const realVariances = run.perCity.flatMap((c) => c.real_variances);
    setState((s) => ({
      ...s,
      lastRun: {
        at: run.ranAt,
        date: run.date,
        total: run.combined.total,
        realCount: run.combined.real_count,
        infoCount: run.combined.info_count,
        highPriority: run.combined.high_priority,
        byVariance: run.combined.by_variance,
        realVariances,
      },
    }));
  }, []);

  return (
    <DemoContext.Provider
      value={{
        ...state,
        closeVariance,
        disputeVariance,
        addUser,
        removeUser,
        recordGuardUpload,
        setUploadStatus,
        applyReconciliationRun,
      }}
    >
      {children}
    </DemoContext.Provider>
  );
}

export function useDemoStore(): DemoStore {
  const ctx = useContext(DemoContext);
  if (!ctx) {
    throw new Error("useDemoStore must be used inside DemoStoreProvider");
  }
  return ctx;
}
