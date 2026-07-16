// Demo-mode authentication — active only while Supabase is not configured.
// These six accounts become real Supabase Auth users + app_users rows (with
// RLS city scoping) once the central DB is provided; this file then goes away.

import type { City, UserRole } from "./sample-data";

export const SESSION_COOKIE = "cf_demo_user";

export interface SessionUser {
  name: string;
  email: string;
  role: UserRole;
  city: City | null;
}

export interface DemoUser extends SessionUser {
  password: string;
}

export const DEMO_USERS: DemoUser[] = [
  { name: "Admin User", email: "admin@cityfurnish.com", password: "admin123", role: "ADMIN", city: null },
  { name: "Rajesh Kumar", email: "delhi.manager@cityfurnish.com", password: "delhi123", role: "MANAGER", city: "DELHI" },
  { name: "Amit Sharma", email: "mumbai.manager@cityfurnish.com", password: "mumbai123", role: "MANAGER", city: "MUMBAI" },
  { name: "Rohan Khanna", email: "pune.manager@cityfurnish.com", password: "pune123", role: "MANAGER", city: "PUNE" },
  { name: "Sneha Joshi", email: "hydrabad.manager@cityfurnish.com", password: "hydrabad123", role: "MANAGER", city: "HYDERABAD" },
  { name: "Vikram Patel", email: "bangalore.manager@cityfurnish.com", password: "bangalore123", role: "MANAGER", city: "BANGALORE" },
];

export function authenticateDemo(
  email: string,
  password: string
): SessionUser | null {
  const match = DEMO_USERS.find(
    (u) =>
      u.email.toLowerCase() === email.trim().toLowerCase() &&
      u.password === password
  );
  if (!match) return null;
  return {
    name: match.name,
    email: match.email,
    role: match.role,
    city: match.city,
  };
}

export function parseSessionCookie(value: string | undefined): SessionUser | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value));
    if (parsed && parsed.email && parsed.role) return parsed as SessionUser;
    return null;
  } catch {
    return null;
  }
}

// Browser-side cookie helpers (demo mode only).
export function setSessionCookie(user: SessionUser) {
  document.cookie = `${SESSION_COOKIE}=${encodeURIComponent(
    JSON.stringify(user)
  )}; path=/; max-age=${60 * 60 * 24 * 7}; samesite=lax`;
}

export function clearSessionCookie() {
  document.cookie = `${SESSION_COOKIE}=; path=/; max-age=0`;
}
