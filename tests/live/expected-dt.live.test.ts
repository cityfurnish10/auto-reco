// What DT would actually add to the expected list, read live.
//
//   LIVE_DT=1 npx vitest run tests/live/expected-dt.live.test.ts
//
// Skipped unless asked for. Every other test mocks the network; this one must
// not, because the question it answers — does DT really carry barcodes on
// SCHEDULED tasks, and do they resolve to our five warehouses — cannot be
// answered by a fixture written from the same assumptions as the code.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fetchDtExpected, formatAddress } from "../../lib/gate/expected-dt";

try {
  for (const l of readFileSync(".env.local", "utf8").split("\n")) {
    const m = l.match(/^\s*([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
  }
} catch { /* reported by the guard below */ }

const live = process.env.LIVE_DT === "1";

describe.skipIf(!live)("what DT would add to the expected list", () => {
  it("returns barcoded, placed, directioned rows for today", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const p = await fetchDtExpected(today);

    console.log(`\n  ${p.rows.length} expected rows from DT for ${today}`);
    console.log(`  skipped: ${p.skipped.unknownCity} unknown city, ` +
                `${p.skipped.ambiguousDirection} ambiguous direction`);

    const byCity: Record<string, number> = {};
    for (const r of p.rows) byCity[r.city] = (byCity[r.city] ?? 0) + 1;
    console.table(byCity);

    const withAddress = p.rows.filter((r) => r.deliveryAddress).length;
    const withCustomer = p.rows.filter((r) => r.customer).length;
    console.log(`  ${withAddress} carry a delivery address, ${withCustomer} a customer`);
    for (const r of p.rows.slice(0, 3)) {
      console.log(`\n   ${r.direction}  ${r.barcode}  ${r.product ?? "—"}`);
      console.log(`      ${r.customer ?? "—"} · ${r.ticketId ?? "—"} · ${r.orderDetails ?? "—"}`);
      console.log(`      ${r.deliveryAddress ?? "(no address)"}`);
    }

    expect(p.rows.length, "DT returned nothing for today").toBeGreaterThan(0);
    // The whole point of adding DT: the human context Odoo cannot supply.
    expect(withAddress, "no row carried a delivery address").toBeGreaterThan(0);
    // Every row must be placeable and directional or it should not be here.
    for (const r of p.rows) {
      expect(["DELHI", "MUMBAI", "PUNE", "HYDERABAD", "BANGALORE"]).toContain(r.city);
      expect(["IN", "OUT"]).toContain(r.direction);
      expect(r.barcode.length).toBeGreaterThan(4);
    }
  }, 90_000);
});

describe("flattening DT's nested address", () => {
  it("builds one readable line", () => {
    expect(formatAddress({
      cf_address_1: "3rd floor B8, B wing Ram Apartments, Yashodham",
      cf_address_2: "Goregaon East", cf_city: "Mumbai", cf_pincode: "400063",
    })).toBe("3rd floor B8, B wing Ram Apartments, Yashodham, Goregaon East, Mumbai, 400063");
  });

  it("drops the fragments that are really empty", () => {
    // Real values: "Near " with nothing after it, and the string "null".
    expect(formatAddress({ cf_address_1: "12 MG Road", cf_address_2: "Near ", cf_area: "null" }))
      .toBe("12 MG Road");
  });

  it("does not repeat a line that appears twice", () => {
    expect(formatAddress({ cf_address_1: "12 MG Road", cf_address_2: "12 MG ROAD" }))
      .toBe("12 MG Road");
  });

  it("returns nothing rather than a scrap", () => {
    expect(formatAddress(null)).toBeNull();
    expect(formatAddress({})).toBeNull();
    expect(formatAddress({ cf_address_1: "x" })).toBeNull();
  });
});
