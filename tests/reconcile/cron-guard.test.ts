// EXACTLY ONE DEPLOYMENT MAY OWN THE SCHEDULE.
//
// The app is now published from two repositories and hosted twice against ONE
// Supabase project. vercel.json declares the crons, so a second Vercel project
// inherits them automatically — and two pipelines on one database can lose a
// whole day's raw feed, because saveSourceRows deletes the rows other runs
// stored for the same (business_date, source).
//
// The flag that prevents that is only as good as its weakest route, so the
// second test below scans the routes themselves. A fifth cron entry point added
// without the guard fails the build rather than quietly doubling the schedule.

import { describe, expect, it, afterEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { NextRequest } from "next/server";
import {
  DISABLED_BODY,
  cronAuthorized,
  scheduledJobsDisabled,
} from "../../lib/reconcile/cron-guard";

const req = (auth?: string): NextRequest =>
  ({ headers: { get: (k: string) => (k === "authorization" ? (auth ?? null) : null) } }) as NextRequest;

const ORIGINAL = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("cronAuthorized", () => {
  it("accepts the exact bearer token", () => {
    process.env.CRON_SECRET = "s3cr3t-value";
    expect(cronAuthorized(req("Bearer s3cr3t-value"))).toBe(true);
  });

  it("rejects a wrong, absent, or differently-shaped header", () => {
    process.env.CRON_SECRET = "s3cr3t-value";
    expect(cronAuthorized(req("Bearer nope"))).toBe(false);
    expect(cronAuthorized(req())).toBe(false);
    expect(cronAuthorized(req("s3cr3t-value"))).toBe(false); // no "Bearer "
  });

  it("refuses everything when no secret is configured", () => {
    // Fail CLOSED. A deployment without CRON_SECRET must not run scheduled work
    // for anyone who asks — including an empty Authorization header.
    delete process.env.CRON_SECRET;
    expect(cronAuthorized(req("Bearer anything"))).toBe(false);
    expect(cronAuthorized(req())).toBe(false);
  });
});

describe("scheduledJobsDisabled", () => {
  it("is OFF unless explicitly set to 1", () => {
    // The default must be "this deployment works normally", so the flag can
    // only ever silence a deployment on purpose.
    delete process.env.SCHEDULED_JOBS_DISABLED;
    expect(scheduledJobsDisabled()).toBe(false);
    for (const v of ["", "0", "false", "true", "yes"]) {
      process.env.SCHEDULED_JOBS_DISABLED = v;
      expect(scheduledJobsDisabled(), `value ${JSON.stringify(v)}`).toBe(false);
    }
  });

  it("is ON for exactly \"1\"", () => {
    process.env.SCHEDULED_JOBS_DISABLED = "1";
    expect(scheduledJobsDisabled()).toBe(true);
  });

  it("answers 200-shaped, never an error", () => {
    // Vercel Cron discards the body and pg_net records its dispatch as
    // succeeded whatever the status, so a 500 here would only make a healthy
    // configuration look broken in the one history that does survive.
    expect(DISABLED_BODY.ok).toBe(true);
    expect(DISABLED_BODY.skipped).toMatch(/disabled on this deployment/);
  });
});

describe("every scheduled entry point is guarded", () => {
  const CRON_DIR = join("app", "api", "cron");
  const routes = readdirSync(CRON_DIR)
    .filter((d) => statSync(join(CRON_DIR, d)).isDirectory())
    .map((d) => ({ name: d, file: join(CRON_DIR, d, "route.ts") }))
    .filter((r) => {
      try {
        return statSync(r.file).isFile();
      } catch {
        return false;
      }
    });

  it("finds the cron routes at all (guards against a silent empty scan)", () => {
    // Without this, a moved directory would make every assertion below vacuous.
    expect(routes.map((r) => r.name).sort()).toEqual(
      expect.arrayContaining(["email-digest", "ocr", "reconcile", "settle"])
    );
  });

  it.each(routes)("$name honours SCHEDULED_JOBS_DISABLED", ({ file }) => {
    const src = readFileSync(file, "utf-8");
    expect(src, `${file} must call scheduledJobsDisabled()`).toContain(
      "scheduledJobsDisabled()"
    );
    expect(src, `${file} must return DISABLED_BODY`).toContain("DISABLED_BODY");
  });

  it.each(routes)("$name checks the bearer token BEFORE the flag", ({ file }) => {
    // Order matters: an unauthenticated caller must never learn which
    // deployment owns the schedule.
    const src = readFileSync(file, "utf-8");
    const auth = src.indexOf("cronAuthorized(req)");
    const flag = src.indexOf("scheduledJobsDisabled()");
    expect(auth, `${file} must use the shared cronAuthorized`).toBeGreaterThan(-1);
    expect(flag).toBeGreaterThan(auth);
  });

  it.each(routes)("$name does not re-implement the bearer check locally", ({ file }) => {
    // The copy that used to live in each route is why a single flag could not
    // be trusted to reach all of them.
    const src = readFileSync(file, "utf-8");
    expect(src, `${file} still declares its own authorized()`).not.toMatch(
      /function authorized\s*\(/
    );
    expect(src, `${file} still imports timingSafeEqual`).not.toContain("timingSafeEqual");
  });
});
