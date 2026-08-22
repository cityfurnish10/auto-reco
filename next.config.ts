import type { NextConfig } from "next";

// Production security headers, applied to every response. This is an internal
// reconciliation tool holding customer/inventory data, so the posture is
// locked down: never framed, never sniffed, no referrer leakage, no browser
// features, and (with X-Robots-Tag) never indexed by a crawler even if the URL
// leaks. HSTS forces HTTPS. These complement — not replace — the network-level
// access control (see PRODUCTION.md) and Supabase Auth + RLS.
const BASE_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

/**
 * Browser features, and the one place this posture has to bend.
 *
 * `camera=()` means DISABLED FOR EVERYONE INCLUDING THIS SITE — empty
 * parentheses are not "default", they are "nobody". That is the right answer
 * for a reconciliation dashboard and it was the right answer for the whole app
 * until the gate work, which is built entirely on the two features it forbids:
 *
 *   camera       reading the QR off the sticker, and the check-in selfie
 *   geolocation  confirming the scan happened at the gate
 *
 * The failure mode is nasty precisely because it is silent: the browser refuses
 * before any application code runs, so getUserMedia rejects with a permission
 * error indistinguishable from a user tapping "Don't allow". It reads as a
 * phone problem, not a header problem.
 *
 * So the strict policy stays everywhere EXCEPT the two paths that need it, and
 * even there it is `(self)` — same origin only, never a third party. Microphone
 * stays off throughout; nothing in this product records audio.
 */
const LOCKED_FEATURES = "camera=(), microphone=(), geolocation=(), interest-cohort=()";
const GATE_FEATURES = "camera=(self), microphone=(), geolocation=(self), interest-cohort=()";

const nextConfig: NextConfig = {
  poweredByHeader: false, // don't advertise the framework
  async headers() {
    return [
      // Everything except the gate app and the Gate section of the dashboard.
      // Written as an exclusion rather than relying on a later rule to override,
      // because two matching entries for the same header key is ambiguous.
      {
        source: "/((?!scan|gate).*)",
        headers: [...BASE_HEADERS, { key: "Permissions-Policy", value: LOCKED_FEATURES }],
      },
      {
        source: "/:path(scan|gate)/:rest*",
        headers: [...BASE_HEADERS, { key: "Permissions-Policy", value: GATE_FEATURES }],
      },
      {
        source: "/:path(scan|gate)",
        headers: [...BASE_HEADERS, { key: "Permissions-Policy", value: GATE_FEATURES }],
      },
    ];
  },
};

export default nextConfig;
