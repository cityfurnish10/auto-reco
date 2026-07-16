"use client";

// Client data layer for admin User Management — fetch + CRUD over /api/users
// (all admin-only, RLS-independent server-side). Mirrors use-dashboard-data.ts.

import { useCallback, useEffect, useState } from "react";
import type { City } from "@/lib/sample-data";
import type { UserRole } from "@/lib/db/schema";

export interface ManagedUser {
  id: string;
  auth_id: string | null;
  email: string;
  name: string;
  role: UserRole; // "admin" | "manager" | "viewer"
  city: City | null;
  status: "active" | "inactive";
  created_at: string;
  updated_at: string;
}

export function useUsers() {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  /* eslint-disable react-hooks/set-state-in-effect -- async-fetch loading toggle */
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fetch("/api/users", { credentials: "same-origin" })
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
        return json.data as ManagedUser[];
      })
      .then((data) => live && setUsers(data ?? []))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [reloadKey]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const refetch = useCallback(() => setReloadKey((k) => k + 1), []);
  return { users, loading, error, refetch };
}

export interface CreateUserInput {
  email: string;
  name: string;
  role: "admin" | "manager";
  city: City | null;
  password: string;
}

export async function createUser(input: CreateUserInput): Promise<void> {
  const res = await fetch("/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `HTTP ${res.status}`);
}

export async function updateUser(
  id: string,
  patch: Partial<{ name: string; role: "admin" | "manager"; city: City | null; status: "active" | "inactive" }>
): Promise<void> {
  const res = await fetch(`/api/users/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `HTTP ${res.status}`);
}

export async function deleteUser(id: string): Promise<void> {
  const res = await fetch(`/api/users/${id}`, { method: "DELETE", credentials: "same-origin" });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `HTTP ${res.status}`);
}
