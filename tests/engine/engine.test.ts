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

describe("Section 4 — Odoo per-city window", () => {
  const base = (city: "DELHI" | "BANGALORE") => [
    r({ source: "PHYSICAL", direction: "OUT", barcode: "ITEM-1", status: "done", date: RUN }),
    r({ source: "ODOO", direction: "OUT", barcode: "ITEM-1", status: "done", createdOn: NEXT }),
  ];

  it("GUR (Delhi) keeps strictly next-day Odoo rows", () => {
    const res = runReconciliation(base("DELHI"), "DELHI");
    // Odoo present (next-day) + physical present, no S/D → not fully reconciled,
    // but Odoo row was kept in-window (no warning about emptying).
    expect(res.warnings).toHaveLength(0);
  });

  it("BAN keeps same-day Odoo; a next-day-only row falls back with a warning", () => {
    const res = runReconciliation(base("BANGALORE"), "BANGALORE");
    // BAN wants created_on == run; our row is next-day → window empties →
    // fallback to all rows + warning (never silent zero).
    expect(res.warnings.length).toBeGreaterThan(0);
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

  it("Odoo-only → Odoo-Only Entry (REAL, High)", () => {
    const res = one([{ source: "ODOO", createdOn: RUN }]);
    const v = res.variances.find((x) => x.barcode === canonicalize("ITEM-1"));
    expect(v?.variance_name).toBe("Odoo-Only Entry — No Floor Record");
    expect(v?.bucket).toBe("REAL");
    expect(v?.priority).toBe("High");
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

  it("spare/consumable label → Spare/Consumable Movement (INFO), not the ladder", () => {
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "PHYSICAL", direction: "OUT", barcode: "SPARE-BOLT-KIT", status: "done" }),
      ],
      "MUMBAI"
    );
    const spare = res.variances.find(
      (v) => v.variance_name === "Spare/Consumable Movement"
    );
    expect(spare).toBeDefined();
    expect(spare?.bucket).toBe("INFO");
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
    const res = runReconciliation(buildSampleRowsByCity(RUN).HYDRABAD, "HYDRABAD");
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
