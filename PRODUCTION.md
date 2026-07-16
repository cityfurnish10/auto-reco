# Production & Security Guide — CityFurnish Auto-Reconciliation

Internal tool holding customer/inventory data for ~6 users (5 city managers +
admin). Used once a day. This guide covers how to deploy it **without exposing
it to the public internet**, what secrets to rotate, and the go-live checklist.

---

## 1. Deployment — how to keep it off the public internet (recommendation)

The app's own auth (Supabase login + RLS + admin-page gating) is already strong,
but "not exposed to the internet" means **no anonymous request should ever reach
the app** — the login page shouldn't even be publicly discoverable. Three viable
models, from most-locked-down to most-convenient:

| Model | How | "Off the internet"? | Ops effort | Best when |
|---|---|---|---|---|
| **A. Self-host + Cloudflare Tunnel** | App runs on an internal VM/Docker with **no public ports**; exposed only through a Cloudflare Tunnel gated by **Cloudflare Access** (email/SSO). | ✅ Strongest — no public IP, no open ports | High (host + tunnel + patching) | You have an internal box and want maximum isolation |
| **B. Cloudflare Access in front of Vercel** ⭐ | Deploy to Vercel, then put **Cloudflare Access (Zero Trust)** or **Vercel Firewall IP-allowlist** in front. Every request must pass Cloudflare/edge auth before it reaches the app. | ✅ Practically — no un-authed request reaches the app | Low | **Recommended.** Distributed managers (5 cities) get easy access, still gated at the network edge |
| **C. Vercel + Supabase-login only** | Public deploy; login page public, rest behind Supabase Auth. | ❌ Publicly reachable (just needs a login) | Lowest | Only if the real requirement is "strong auth", not network isolation |

### Recommendation: **B — Cloudflare Access on top of the deployment.**

Reasoning for *this* app: the 5 managers are geographically spread across
cities and warehouses, so a strict "VPN/office-network only" model (A) adds real
friction (everyone needs VPN). Cloudflare Access gives you the "no anonymous
request reaches the app" guarantee **and** works for distributed users — you
allowlist the 6 work emails (or your Google Workspace domain) and Cloudflare
challenges every visitor at the edge before Vercel ever sees them. Free tier
covers up to 50 users. If you already have an internal server and want the
absolute tightest posture, do **A** (same Cloudflare Access, just pointed at a
Tunnel instead of Vercel).

Whichever host you pick, it needs **outbound** internet regardless (to reach
Supabase, MongoDB Atlas, Metabase, Azure Vision, Google Sheets).

### Cloudflare Access — setup sketch (model B)
1. Deploy to Vercel (or any host). Note the deployment URL.
2. Put the domain behind Cloudflare (orange-cloud the DNS record).
3. Cloudflare Zero Trust → Access → Applications → Add a self-hosted app for the
   domain. Policy: **Allow** → emails in `{the 6 work emails}` (or `@cityfurnish.com`).
4. (Vercel) In Project → Deployment Protection, restrict to Cloudflare's IPs, or
   use Vercel's own IP-allowlist so the app can *only* be hit via Cloudflare.
5. The nightly cron (below) authenticates with `CRON_SECRET`, so it works from a
   Cloudflare Access **service token** or Vercel Cron regardless of the user wall.

---

## 2. Secrets to rotate before go-live

These were typed in plaintext during development, so treat them as compromised
and **rotate before production**. All live in gitignored `.env.local` (never
committed — verified), and must be set as env vars in the host (Vercel/host),
**not** committed anywhere.

- [ ] **Supabase DB password** — Project Settings → Database → Reset password.
- [ ] **Supabase `service_role` key** — rotate in API settings; server-only.
- [ ] **DT MongoDB `atlasAdmin` password** — Atlas → Database Access. Prefer a
      **read-only** user scoped to the `cityfurnish` DB, not `atlasAdmin`.
- [ ] **Azure Vision API key** — regenerate Key1 in the Azure portal.
- [ ] **Metabase** — swap the personal username/password login for a dedicated
      **Metabase API key** (Admin → API Keys) so the cron doesn't depend on one
      user's password. Set `METABASE_API_KEY`, clear `METABASE_USERNAME/PASSWORD`.
- [ ] **`CRON_SECRET`** — generate a fresh 32-byte random value for prod
      (`openssl rand -hex 32`); it's fine as-is but regenerate on go-live.
- [ ] **Google service-account key** — fine to keep; ensure it stays least-priv
      (Viewer on the 5 sheets only).

Env vars the host must have: see `.env.example` for the full list.

---

## 3. Application security posture (in code)

Already in place:
- **Auth on every route** — all 10 API routes check `auth.getUser()` /
  `CRON_SECRET`; RLS-scoped routes also sit behind middleware auth.
- **RLS** — managers only ever read/write their own city's rows (DB-enforced).
- **Admin-page gating** — `/users`, `/analytics`, `/system-health`,
  `/email-digest` are admin-only in middleware (prod branch), verified via
  `app_users.role`.
- **Security headers** (`next.config.ts`) — HSTS, `X-Frame-Options: DENY`,
  `nosniff`, no-referrer-leak, `X-Robots-Tag: noindex`, restrictive
  Permissions-Policy, `poweredByHeader` off.
- **`robots.ts`** — disallow all crawlers.
- **Timing-safe `CRON_SECRET`** comparison.
- **Signed Storage upload URLs** for guard PDFs (bytes never transit our API).
- Secrets are server-only; only `NEXT_PUBLIC_*` (Supabase URL + anon key,
  RLS-protected) reach the browser.

Still recommended before go-live:
- [ ] Rate-limit `/api/cron/reconcile` and the login (Cloudflare rule or
      Vercel Firewall) — the network wall largely covers this.
- [ ] `security-review` pass over the full branch diff.

---

## 4. Nightly reconcile (scheduler)

The pipeline is `POST /api/cron/reconcile?date=<D-1>` with
`Authorization: Bearer <CRON_SECRET>`. Options by deployment:
- **Vercel Cron** (`vercel.json` `crons`) — hits the route on a schedule; add the
  `CRON_SECRET` via a Cloudflare service token or an internal call.
- **Self-host** — a system `cron` / `systemd` timer, or Supabase **pg_cron**
  calling an edge function that posts to the route.

Run once a day after midnight IST (the D-1 default targets yesterday). Enable
`pg_cron` for the nightly `prune_expired()` too (source_rows > 7 days).

---

## 5. Go-live checklist

- [ ] Rotate all secrets (§2); set as host env vars.
- [ ] Choose + configure the access wall (§1, recommend Cloudflare Access).
- [ ] First real reconcile persisted (`POST /api/cron/reconcile?date=…`) →
      confirm the dashboard shows live variances.
- [ ] Wire the nightly scheduler (§4) + `prune_expired()`.
- [ ] Rewire or hide the still-demo pages (analytics / users / system-health /
      email-digest / leaderboard) — they currently render sample data.
- [ ] Email digest via Resend (`RESEND_API_KEY`, `DIGEST_RECIPIENTS`).
- [ ] `security-review` pass.
