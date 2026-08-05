// upsertVariances is on the nightly pipeline's critical path: a throw there is
// caught by the pipeline's outer handler, marks the run failed, and leaves the
// whole day with NO variances. These tests pin the behaviour that stops eight
// display booleans from being able to do that.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { upsertVariances } from "../../lib/db/persist";
import type { CityRunResult, VarianceRowOut } from "../../lib/engine/types";

const PRESENCE_KEYS = [
  "present_p", "present_s", "present_d", "present_o",
  "reported_p", "reported_s", "reported_d", "reported_o",
];

function row(over: Partial<VarianceRowOut> = {}): VarianceRowOut {
  return {
    barcode: "ITEM-1",
    barcode_display: "ITEM-1",
    city: "MUMBAI",
    direction: "OUT",
    variance_name: "Gate Register Only — No Ops / DT / Odoo Record",
    priority: "High",
    bucket: "REAL",
    responsible: "warehouse_team",
    ticket_id: "T-1",
    so_number: "SO-1",
    customer: "Ravi",
    product: "Sofa",
    job_type: null,
    date: "2026-07-26",
    note: "n",
    present: { P: true, S: false, D: false, O: false },
    reported: { P: true, S: true, D: true, O: false },
    ...over,
  };
}

const cityResult = (): CityRunResult =>
  ({ city: "MUMBAI", variances: [row()] }) as unknown as CityRunResult;

/** Minimal stub: records every upsert payload, replies from a scripted queue. */
function stubDb(replies: { error: { code?: string; message: string } | null }[]) {
  const payloads: Record<string, unknown>[][] = [];
  let call = 0;
  const db = {
    from() {
      return {
        upsert(payload: Record<string, unknown>[]) {
          payloads.push(payload);
          return Promise.resolve(replies[call++] ?? { error: null });
        },
      };
    },
  };
  return { db: db as never, payloads, calls: () => call };
}

beforeEach(() => vi.restoreAllMocks());

describe("upsertVariances — migration 0013 degradation", () => {
  it("writes the eight presence columns when they exist", async () => {
    const { db, payloads } = stubDb([{ error: null }]);
    const n = await upsertVariances(db, "run-1", [cityResult()]);
    expect(n).toBe(1);
    expect(payloads).toHaveLength(1);
    expect(payloads[0][0]).toMatchObject({
      present_p: true, present_s: false, present_d: false, present_o: false,
      reported_p: true, reported_s: true, reported_d: true, reported_o: false,
    });
  });

  it("retries without them on 42703 rather than failing the whole run", async () => {
    // A database missing 0013 rejects EVERY payload carrying present_p, so the
    // stub has to reject twice: once for the full row, once for the row with
    // only 0020's column dropped. A stub that accepted the second would be
    // claiming a column is both absent and writable.
    const { db, payloads, calls } = stubDb([
      { error: { code: "42703", message: 'column "present_p" does not exist' } },
      { error: { code: "42703", message: 'column "present_p" does not exist' } },
      { error: null },
    ]);
    const n = await upsertVariances(db, "run-1", [cityResult()]);
    expect(n).toBe(1);
    expect(calls()).toBe(3);
    for (const k of PRESENCE_KEYS) expect(payloads[2][0]).not.toHaveProperty(k);
    expect(payloads[2][0]).not.toHaveProperty("barcode_display");
    // The legacy columns must still be there — this is a retry, not a skip.
    expect(payloads[2][0]).toMatchObject({ barcode: "ITEM-1", bucket: "REAL", city: "MUMBAI" });
  });

  it("drops ONLY 0020's column when 0013 is applied and 0020 is not", async () => {
    // The whole point of the two-step ladder. Stripping both at once would
    // throw away the presence flags on a database that has them, and those are
    // the difference between "this source says no" and "this source never
    // filed" — which is what the dashboard badges and the email's dashes read.
    const { db, payloads, calls } = stubDb([
      { error: { code: "PGRST204", message: "Could not find the 'barcode_display' column of 'variances' in the schema cache" } },
      { error: null },
    ]);
    const n = await upsertVariances(db, "run-1", [cityResult()]);
    expect(n).toBe(1);
    expect(calls()).toBe(2);
    expect(payloads[1][0]).not.toHaveProperty("barcode_display");
    for (const k of PRESENCE_KEYS) expect(payloads[1][0]).toHaveProperty(k);
  });

  it("writes barcode_display when the column exists", async () => {
    const { db, payloads } = stubDb([{ error: null }]);
    await upsertVariances(db, "run-1", [cityResult()]);
    expect(payloads[0][0]).toMatchObject({ barcode: "ITEM-1", barcode_display: "ITEM-1" });
  });

  it("also retries on PostgREST's PGRST204 schema-cache wording", async () => {
    // PostgREST often reports an unknown column as a schema-cache miss rather
    // than 42703; a code-only guard would miss it and fail the nightly run.
    const { db, calls } = stubDb([
      { error: { code: "PGRST204", message: "Could not find the 'present_p' column of 'variances' in the schema cache" } },
      { error: null },
    ]);
    await expect(upsertVariances(db, "run-1", [cityResult()])).resolves.toBe(1);
    expect(calls()).toBe(2);
  });

  it("still throws on an unrelated error", async () => {
    const { db, calls } = stubDb([
      { error: { code: "23505", message: "duplicate key value violates unique constraint" } },
    ]);
    await expect(upsertVariances(db, "run-1", [cityResult()])).rejects.toThrow(/duplicate key/);
    expect(calls()).toBe(1);
  });

  it("throws if the retry itself fails", async () => {
    const { db } = stubDb([
      { error: { code: "42703", message: "does not exist" } },
      { error: { code: "08006", message: "connection failure" } },
    ]);
    await expect(upsertVariances(db, "run-1", [cityResult()])).rejects.toThrow(/connection failure/);
  });
});
