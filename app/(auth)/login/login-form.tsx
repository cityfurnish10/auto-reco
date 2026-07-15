"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getSupabaseClient } from "@/lib/supabase/client";
import { authenticateDemo, setSessionCookie } from "@/lib/demo-auth";
import { Icon } from "@/components/icon";

const supabaseConfigured =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
  !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export default function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    // Demo mode until the central Supabase DB is provided — credentials are
    // checked against the provisioned demo accounts (admin + 5 city managers).
    if (!supabaseConfigured) {
      const user = authenticateDemo(email, password);
      if (!user) {
        setError(
          "Invalid credentials. Contact your administrator for access."
        );
        setLoading(false);
        return;
      }
      setSessionCookie(user);
      router.push(searchParams.get("next") ?? "/dashboard");
      router.refresh();
      return;
    }

    const supabase = getSupabaseClient();
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError("Invalid credentials. Contact your administrator for access.");
      setLoading(false);
      return;
    }

    router.push(searchParams.get("next") ?? "/dashboard");
    router.refresh();
  }

  return (
    <div className="min-h-screen flex flex-col">
      <main className="flex-grow flex items-center justify-center px-container-margin navy-pattern">
        <div className="w-full max-w-[400px] card login-card-shadow overflow-hidden p-10 flex flex-col items-center">
          <header className="mb-10 text-center">
            <h1 className="font-headline text-xl font-black text-accent tracking-tighter uppercase">
              CityFurnish
            </h1>
            <p className="text-xs text-text-muted tracking-widest mt-1">
              OPERATIONS PORTAL
            </p>
          </header>

          <form onSubmit={handleSubmit} className="w-full space-y-6">
            <div className="space-y-1.5">
              <label
                className="text-sm font-medium text-text-secondary flex items-center gap-2"
                htmlFor="email"
              >
                <Icon name="mail" size={18} />
                Email Address
              </label>
              <input
                className="input-clean w-full h-11!"
                id="email"
                type="email"
                required
                autoComplete="email"
                placeholder="warehouse.manager@cityfurnish.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <label
                className="text-sm font-medium text-text-secondary flex items-center gap-2"
                htmlFor="password"
              >
                <Icon name="lock" size={18} />
                Password
              </label>
              <input
                className="input-clean w-full h-11!"
                id="password"
                type="password"
                required
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            {error && (
              <p className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">
                {error}
              </p>
            )}

            <div className="pt-2">
              <button
                className="btn btn-primary w-full h-11!"
                type="submit"
                disabled={loading}
              >
                {loading ? (
                  <>
                    <svg
                      className="animate-spin h-5 w-5 text-white"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      ></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      ></path>
                    </svg>
                    Authenticating…
                  </>
                ) : (
                  <>
                    Login
                    <Icon name="login" size={18} />
                  </>
                )}
              </button>
            </div>
          </form>

          <div className="mt-10 pt-6 border-t border-border w-full">
            <div className="flex items-center justify-center gap-3 opacity-40">
              <div className="h-px bg-border flex-grow"></div>
              <Icon name="verified_user" size={16} />
              <div className="h-px bg-border flex-grow"></div>
            </div>
          </div>
        </div>
      </main>

      <footer className="w-full py-6 text-center navy-pattern border-t border-white/5">
        <p className="text-xs text-white opacity-40 tracking-[0.2em] uppercase">
          Internal use only.
        </p>
      </footer>
    </div>
  );
}
