import type { NextConfig } from "next";

// Production security headers, applied to every response. This is an internal
// reconciliation tool holding customer/inventory data, so the posture is
// locked down: never framed, never sniffed, no referrer leakage, no browser
// features, and (with X-Robots-Tag) never indexed by a crawler even if the URL
// leaks. HSTS forces HTTPS. These complement — not replace — the network-level
// access control (see PRODUCTION.md) and Supabase Auth + RLS.
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false, // don't advertise the framework
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
