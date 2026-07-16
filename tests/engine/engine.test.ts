import { describe, expect, it } from "vitest";
import { parseDate, deriveRunDate, addDays } from "../../lib/engine/dates";
import { canonicalize, isValidBarcode, isSpareOrConsumable } from "../../lib/engine/barcode";
import { runReconciliation } from "../../lib/engine/run";
import { buildSampleRowsByCity } from "../../lib/sample-raw-sources";
import type { SourceRow } from "../../lib/engine/types";

const RUN = "2026-07-12";
const NEXT = "2026-07-13";

// Small row builder for focused tests.
function r(p: Partial<SourceRow> & Pick<SourceRow, "source" | "direction" | "barcode">): SourceRow {
  return { date: RUN, ...p } as SourceRow;
}

// A fully-reconciled decoy so run-date derivation (physical/DT-driven) has an
// anchor even when the item under test only appears in Odoo. Produces no
// variance itself, so it never pollutes assertions.
function anchor(): SourceRow[] {
  return [
    r({ source: "PHYSICAL", direction: "OUT", barcode: "ANCHOR-OK-1", status: "done", date: RUN }),
    r({ source: "SHEET", direction: "OUT", barcode: "ANCHOR-OK-1", status: "done" }),
    r({ source: "DT", direction: "OUT", barcode: "ANCHOR-OK-1", status: "done", date: RUN }),
    r({ source: "ODOO", direction: "OUT", barcode: "ANCHOR-OK-1", status: "done", createdOn: RUN }),
  ];
}

describe("Section 3 — date parsing & run-date derivation", () => {
  it("parses ISO, day-first d/m/y, and Excel serials", () => {
    expect(parseDate("2026-07-12")).toBe("2026-07-12");
    expect(parseDate("12/07/2026")).toBe("2026-07-12"); // day-first default
    expect(parseDate("12.07.2026")).toBe("2026-07-12");
    expect(parseDate(46215)).toBe("2026-07-12"); // Excel serial
  });

  it("derives run date as the most common physical/DT date", () => {
    const rows = [
      r({ source: "PHYSICAL", direction: "OUT", barcode: "AAAAA", date: RUN }),
      r({ source: "DT", direction: "OUT", barcode: "AAAAA", date: RUN }),
      r({ source: "PHYSICAL", direction: "OUT", barcode: "BBBBB", date: "2026-07-11" }),
    ];
    expect(deriveRunDate(rows)).toBe(RUN);
  });

  it("throws when no date can be parsed (never silent wrong-day)", () => {
    const rows = [r({ source: "PHYSICAL", direction: "OUT", barcode: "AAAAA", date: "garbage" })];
    expect(() => deriveRunDate(rows)).toThrow(/Run-date derivation failed/);
  });

  it("addDays crosses month boundaries", () => {
    expect(addDays("2026-07-12", 1)).toBe("2026-07-13");
    expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
  });
});

describe("Section 5 — barcode validity & canonicalization", () => {
  it("folds only the sanctioned OCR confusions after upper+strip", () => {
    expect(canonicalize("io sz g")).toBe("10526"); // I→1 O→0 S→5 Z→2 G→6
    expect(canonicalize("bc-100")).toBe("BC-100");
  });

  it("rejects short, non-alphanumeric, and placeholder barcodes", () => {
    expect(isValidBarcode("ABC")).toBe(false); // < 5
    expect(isValidBarcode("-")).toBe(false);
    expect(isValidBarcode("n/a")).toBe(false);
    expect(isValidBarcode("CF-BED-1")).toBe(true);
  });

  it("detects spare/consumable placeholders", () => {
    expect(isSpareOrConsumable("SPARE-KIT")).toBe(true);
    expect(isSpareOrConsumable("consumable pack")).toBe(true);
  });
});

describe("Section 4 — Odoo posting-date window (uniform ±1 day)", () => {
  const base = (createdOn: string) => [
    r({ source: "PHYSICAL", direction: "OUT", barcode: "ITEM-1", status: "done", date: RUN }),
    r({ source: "ODOO", direction: "OUT", barcode: "ITEM-1", status: "done", createdOn }),
  ];

  it("keeps a next-day posting for every city (posting lag is the norm)", () => {
    for (const city of ["DELHI", "BANGALORE", "MUMBAI"] as const) {
      const res = runReconciliation(base(NEXT), city);
      expect(res.warnings).toHaveLength(0);
      // Odoo matched the physical row → NOT "Register/DT"-style Odoo-missing.
      expect(
        res.variances.some((v) => v.variance_name.includes("Not in Odoo") || v.variance_name.includes("No Odoo"))
      ).toBe(false);
    }
  });

  it("a posting outside ±1 day falls back with a warning (never silent zero)", () => {
    const res = runReconciliation(base("2026-07-20"), "BANGALORE");
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it("adjacent-day postings never surface as Odoo-Only (judged in their own run)", () => {
    const res = runReconciliation(
      [
        ...anchor(),
        // Next-day posting, nothing else anywhere → match-target only.
        r({ source: "ODOO", direction: "OUT", barcode: "LAGGED-1", status: "done", createdOn: NEXT }),
      ],
      "MUMBAI"
    );
    expect(
      res.variances.find((v) => v.barcode === canonicalize("LAGGED-1"))
    ).toBeUndefined();
  });
});

describe("Reported-source gating (outage / no-guard modes)", () => {
  const rep = (over: Partial<{ P: boolean; S: boolean; D: boolean; O: boolean }>) => ({
    P: true, S: true, D: true, O: true, ...over,
  });

  it("no-guard mode: Sheet+DT agree, Odoo missing → REAL 'Not in Odoo' (the ops chase item)", () => {
    const res = runReconciliation(
      [
        r({ source: "SHEET", direction: "OUT", barcode: "ITEM-2", status: "done" }),
        r({ source: "DT", direction: "OUT", barcode: "ITEM-2", status: "done", date: RUN }),
      ],
      "MUMBAI",
      rep({ P: false })
    );
    const v = res.variances.find((x) => x.barcode === canonicalize("ITEM-2"));
    expect(v?.variance_name).toBe("Register/DT Logged — Not in Odoo");
    expect(v?.bucket).toBe("REAL");
  });

  it("guard reported: same pattern stays the 4-source INFO cross-check", () => {
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "SHEET", direction: "OUT", barcode: "ITEM-2", status: "done" }),
        r({ source: "DT", direction: "OUT", barcode: "ITEM-2", status: "done", date: RUN }),
      ],
      "MUMBAI"
    );
    const v = res.variances.find((x) => x.barcode === canonicalize("ITEM-2"));
    expect(v?.variance_name).toBe("Odoo Update Pending — Cross-Check");
    expect(v?.bucket).toBe("INFO");
  });

  it("Odoo outage: absence variances against Odoo are silenced", () => {
    const res = runReconciliation(
      [
        r({ source: "SHEET", direction: "OUT", barcode: "ITEM-3", status: "done" }),
        r({ source: "DT", direction: "OUT", barcode: "ITEM-3", status: "done", date: RUN }),
      ],
      "MUMBAI",
      rep({ P: false, O: false })
    );
    expect(
      res.variances.find((x) => x.barcode === canonicalize("ITEM-3"))
    ).toBeUndefined();
  });

  it("sheet not filled in (unreported): DT-only does NOT become Fake Scan Risk", () => {
    const res = runReconciliation(
      [
        r({ source: "DT", direction: "OUT", barcode: "ITEM-4", status: "done", date: RUN }),
        // Odoo reported for the city via another barcode:
        r({ source: "ODOO", direction: "OUT", barcode: "OTHER-9", status: "done", createdOn: RUN }),
      ],
      "MUMBAI",
      rep({ P: false, S: false })
    );
    const v = res.variances.find((x) => x.barcode === canonicalize("ITEM-4"));
    // Floor sources both unreported → corroboration vacuous → Odoo-missing REAL.
    expect(v?.variance_name).toBe("Register/DT Logged — Not in Odoo");
  });

  it("no-guard mode: Sheet+Odoo agree, DT missing → INFO (not Gate Log Missing)", () => {
    const res = runReconciliation(
      [
        r({ source: "SHEET", direction: "OUT", barcode: "ITEM-5", status: "done" }),
        r({ source: "ODOO", direction: "OUT", barcode: "ITEM-5", status: "done", createdOn: RUN }),
        // date anchor (deriveRunDate needs a PHYSICAL/DT row):
        r({ source: "DT", direction: "OUT", barcode: "ANCHOR-DT-1", status: "done", date: RUN }),
        r({ source: "SHEET", direction: "OUT", barcode: "ANCHOR-DT-1", status: "done" }),
        r({ source: "ODOO", direction: "OUT", barcode: "ANCHOR-DT-1", status: "done", createdOn: RUN }),
      ],
      "MUMBAI",
      rep({ P: false })
    );
    const v = res.variances.find((x) => x.barcode === canonicalize("ITEM-5"));
    expect(v?.variance_name).toBe("DT Missing — Ops & Odoo Agree");
    expect(v?.bucket).toBe("INFO");
  });
});

describe("Failed delivery & PP boxes (ops-practice rules)", () => {
  it("OUT marked Not Delivered with no IN return entry → REAL chase item", () => {
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "SHEET", direction: "OUT", barcode: "FAILED-1", status: "Not Delivered" }),
      ],
      "MUMBAI"
    );
    const v = res.variances.find((x) => x.barcode === canonicalize("FAILED-1"));
    expect(v?.variance_name).toBe("Failed Delivery — Return Not Logged");
    expect(v?.bucket).toBe("REAL");
  });

  it("OUT Not Delivered WITH an IN return entry → silent (return was logged)", () => {
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "SHEET", direction: "OUT", barcode: "FAILED-2", status: "Not Delivered" }),
        r({ source: "SHEET", direction: "IN", barcode: "FAILED-2", status: "done" }),
        r({ source: "DT", direction: "IN", barcode: "FAILED-2", status: "done", date: RUN }),
        r({ source: "ODOO", direction: "IN", barcode: "FAILED-2", status: "done", createdOn: RUN }),
      ],
      "MUMBAI",
      { P: false, S: true, D: true, O: true }
    );
    expect(
      res.variances.find(
        (x) => x.barcode === canonicalize("FAILED-2") && x.variance_name === "Failed Delivery — Return Not Logged"
      )
    ).toBeUndefined();
    // And the not-delivered OUT row must not fire Sheet-Only either.
    expect(
      res.variances.find(
        (x) => x.barcode === canonicalize("FAILED-2") && x.direction === "OUT"
      )
    ).toBeUndefined();
  });

  it("PP box entries are counted (summary.pp_box_count), not variance rows", () => {
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "SHEET", direction: "OUT", barcode: "PP BOX - 29", status: "done" }),
        r({ source: "SHEET", direction: "OUT", barcode: 'PP Box 32" TV - 03', status: "done" }),
      ],
      "MUMBAI"
    );
    // No longer a variance row — surfaced as a per-city count instead.
    expect(res.variances.some((v) => v.variance_name === "PP Box Movement (Count Only)")).toBe(false);
    expect(res.summary.pp_box_count).toBe(2);
    // They must never run the normal ladder as fake barcodes.
    expect(res.variances.some((v) => v.variance_name === "Sheet-Only Dispatch — No Trail")).toBe(false);
  });
});

describe("Section 6 — variance ladder", () => {
  const one = (
    parts: Array<Partial<SourceRow> & Pick<SourceRow, "source">>
  ) =>
    runReconciliation(
      [
        ...anchor(),
        ...parts.map((p) =>
          r({ direction: "OUT", barcode: "ITEM-1", status: "done", ...p })
        ),
      ],
      "MUMBAI"
    );

  it("Odoo-only → Odoo-Only Entry (INFO tally; natural priority preserved)", () => {
    const res = one([{ source: "ODOO", createdOn: RUN }]);
    const v = res.variances.find((x) => x.barcode === canonicalize("ITEM-1"));
    expect(v?.variance_name).toBe("Odoo-Only Entry — No Floor Record");
    // Measured on live data: these are overwhelmingly Odoo batch-posting
    // earlier days' movements — an audit tally, not a morning chase item.
    expect(v?.bucket).toBe("INFO");
    expect(v?.priority).toBe("Info");
    expect(v?.original_priority).toBe("High");
  });

  it("gate-only → Gate-Only Dispatch (REAL)", () => {
    const res = one([{ source: "PHYSICAL" }]);
    expect(res.variances[0].variance_name).toBe(
      "Gate-Only Dispatch — No Ops/Odoo Trail"
    );
  });

  it("P+S+D no O → Register/DT Logged — Not in Odoo (REAL)", () => {
    const res = one([
      { source: "PHYSICAL" },
      { source: "SHEET" },
      { source: "DT" },
    ]);
    expect(res.variances[0].variance_name).toBe(
      "Register/DT Logged — Not in Odoo"
    );
  });

  it("P+S+O no D → Odoo Update Pending (INFO, dampened)", () => {
    const res = one([
      { source: "PHYSICAL" },
      { source: "SHEET" },
      { source: "ODOO", createdOn: RUN },
    ]);
    const v = res.variances[0];
    expect(v.variance_name).toBe("Odoo Update Pending — Movement Confirmed");
    expect(v.bucket).toBe("INFO");
    expect(v.priority).toBe("Info");
    expect(v.dampened).toBe(true);
    expect(v.original_priority).toBe("Info");
  });

  it("all four present & consistent → no variance", () => {
    const res = one([
      { source: "PHYSICAL" },
      { source: "SHEET" },
      { source: "DT" },
      { source: "ODOO", createdOn: RUN },
    ]);
    expect(res.variances).toHaveLength(0);
  });

  it("DT non_match → Fake Scan Risk (top priority)", () => {
    const res = runReconciliation(
      [
        r({ source: "PHYSICAL", direction: "OUT", barcode: "ITEM-1", status: "done" }),
        r({ source: "DT", direction: "OUT", barcode: "ITEM-1", status: "non_match" }),
      ],
      "MUMBAI"
    );
    expect(res.variances[0].variance_name).toBe("Fake Scan Risk");
  });
});

describe("Section 7 — suppressions", () => {
  it("DT All-Pending suppresses every variance for the barcode", () => {
    const res = runReconciliation(
      [
        r({ source: "PHYSICAL", direction: "OUT", barcode: "ITEM-1", status: "done" }),
        r({ source: "DT", direction: "OUT", barcode: "ITEM-1", status: "pending" }),
        r({ source: "DT", direction: "OUT", barcode: "ITEM-1", status: "pending" }),
      ],
      "MUMBAI"
    );
    expect(
      res.variances.find((v) => v.barcode === canonicalize("ITEM-1"))
    ).toBeUndefined();
  });

  it("Internal Repair Movement (OUT) with no ticket/customer/SO is suppressed", () => {
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "ODOO", direction: "OUT", barcode: "REPAIR-1", status: "done", jobType: "REPAIR", createdOn: RUN }),
      ],
      "MUMBAI"
    );
    expect(
      res.variances.find((v) => v.barcode === canonicalize("REPAIR-1"))
    ).toBeUndefined();
  });

  it("spare/consumable label → counted (summary.consumable_count), not the ladder", () => {
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "PHYSICAL", direction: "OUT", barcode: "SPARE-BOLT-KIT", status: "done" }),
      ],
      "MUMBAI"
    );
    // No longer a variance row — surfaced as a per-city count instead.
    expect(res.variances.some((v) => v.variance_name === "Spare/Consumable Movement")).toBe(false);
    expect(res.summary.consumable_count).toBe(1);
    // It must NOT have been classified as a gate-only REAL variance.
    expect(
      res.variances.some(
        (v) => v.variance_name === "Gate-Only Dispatch — No Ops/Odoo Trail"
      )
    ).toBe(false);
  });

  it("Silent OCR/SO-match never appears in output", () => {
    const res = runReconciliation(
      [
        // Physical has the SO under barcode SOFA-AAAAA…
        r({ source: "PHYSICAL", direction: "OUT", barcode: "SOFA-AAAAA", status: "done", soNumber: "SO-1", product: "Sofa Blue" }),
        r({ source: "SHEET", direction: "OUT", barcode: "SOFA-AAAAA", status: "done", soNumber: "SO-1", product: "Sofa Blue" }),
        r({ source: "DT", direction: "OUT", barcode: "SOFA-AAAAA", status: "done", soNumber: "SO-1", product: "Sofa Blue" }),
        r({ source: "ODOO", direction: "OUT", barcode: "SOFA-AAAAA", status: "done", createdOn: RUN, soNumber: "SO-1", product: "Sofa Blue" }),
        // …and Odoo also lists the same SO under a DIFFERENT barcode, same product.
        r({ source: "ODOO", direction: "OUT", barcode: "SOFA-BBBBB", status: "done", createdOn: RUN, soNumber: "SO-1", product: "Sofa Blue" }),
      ],
      "MUMBAI"
    );
    // SOFA-BBBBB is missing from physical but shares SO-1 + product → silent.
    expect(
      res.variances.find((v) => v.barcode === canonicalize("SOFA-BBBBB"))
    ).toBeUndefined();
  });
});

describe("Section 8 — direction conflict", () => {
  it("fires when the same SO+unit is IN and OUT with OUT completed", () => {
    const res = runReconciliation(
      [
        r({ source: "PHYSICAL", direction: "OUT", barcode: "UNIT-1", status: "done", soNumber: "SO-9" }),
        r({ source: "DT", direction: "OUT", barcode: "UNIT-1", status: "done", soNumber: "SO-9" }),
        r({ source: "PHYSICAL", direction: "IN", barcode: "UNIT-1", status: "done", soNumber: "SO-9" }),
        r({ source: "SHEET", direction: "IN", barcode: "UNIT-1", status: "done", soNumber: "SO-9" }),
      ],
      "MUMBAI"
    );
    const dc = res.variances.find((v) => v.variance_name === "Direction Conflict");
    expect(dc).toBeDefined();
    expect(dc?.direction).toBe("CROSS");
    expect(dc?.responsible).toBe("warehouse_team");
  });
});

describe("Section 10/11 — buckets & output contract", () => {
  it("splits variances into real_variances and info_variances", () => {
    const res = runReconciliation(buildSampleRowsByCity(RUN).HYDERABAD, "HYDERABAD");
    expect(res.real_variances.every((v) => v.bucket === "REAL")).toBe(true);
    expect(res.info_variances.every((v) => v.bucket === "INFO")).toBe(true);
    expect(res.summary.total).toBe(
      res.real_variances.length + res.info_variances.length
    );
  });

  it("emits a count layer for IN and OUT", () => {
    const res = runReconciliation(buildSampleRowsByCity(RUN).DELHI, "DELHI");
    expect(res.count_out.primary_source).toBe("PHYSICAL");
    expect(typeof res.count_out.dt_diff).toBe("number");
    expect(typeof res.count_out.odoo_diff).toBe("number");
  });

  it("is deterministic: identical input → identical variances", () => {
    const rows = buildSampleRowsByCity(RUN).PUNE;
    const a = runReconciliation(rows, "PUNE");
    const b = runReconciliation(rows, "PUNE");
    expect(a.variances).toEqual(b.variances);
  });

  it("sample data produces both REAL and INFO across every city", () => {
    const byCity = buildSampleRowsByCity(RUN);
    for (const city of Object.keys(byCity) as Array<keyof typeof byCity>) {
      const res = runReconciliation(byCity[city], city);
      expect(res.real_variances.length).toBeGreaterThan(0);
      expect(res.info_variances.length).toBeGreaterThan(0);
    }
  });
});
