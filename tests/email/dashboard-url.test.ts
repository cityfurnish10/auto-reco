import { afterEach, describe, expect, it } from "vitest";
import { dashboardUrl } from "../../lib/email";

const PROD = "https://auto-reco.vercel.app/dashboard";
const original = process.env.NEXT_PUBLIC_APP_URL;

afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = original;
});

const withEnv = (v: string | undefined) => {
  if (v === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = v;
  return dashboardUrl();
};

describe("dashboardUrl — a recipient must be able to open it", () => {
  it("uses the production domain when nothing is set", () => {
    expect(withEnv(undefined)).toBe(PROD);
  });

  it("IGNORES localhost, which is what .env.local actually contains", () => {
    // The defect: a send from a local run, or from a deployment whose env was
    // pasted wrong, put "http://localhost:3000/dashboard" in front of eight
    // people as the email's only call to action.
    expect(withEnv("http://localhost:3000")).toBe(PROD);
    expect(withEnv("https://localhost:3000")).toBe(PROD);
    expect(withEnv("http://127.0.0.1:3000")).toBe(PROD);
  });

  it("ignores a LAN address — a colleague's laptop is not reachable", () => {
    expect(withEnv("http://192.168.1.10:3000")).toBe(PROD);
    expect(withEnv("https://10.0.0.5")).toBe(PROD);
    expect(withEnv("https://172.16.4.4")).toBe(PROD);
  });

  it("ignores plain http even on a public host — mail clients flag it", () => {
    expect(withEnv("http://auto-reco.vercel.app")).toBe(PROD);
  });

  it("ignores junk rather than emitting a malformed link", () => {
    expect(withEnv("not a url")).toBe(PROD);
    expect(withEnv("")).toBe(PROD);
  });

  it("HONOURS a real custom domain, which is the point of the override", () => {
    expect(withEnv("https://ops.cityfurnish.com")).toBe("https://ops.cityfurnish.com/dashboard");
  });

  it("tolerates a trailing slash without doubling it", () => {
    expect(withEnv("https://ops.cityfurnish.com/")).toBe("https://ops.cityfurnish.com/dashboard");
  });
});
