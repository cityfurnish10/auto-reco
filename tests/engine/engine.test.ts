import { describe, expect, it } from "vitest";
import { parseDate, deriveRunDate, addDays } from "../../lib/engine/dates";
import { canonicalize, isValidBarcode, isSpareOrConsumable } from "../../lib/engine/barcode";
import { normalizeStatus } from "../../lib/engine/util";
import { runReconciliation } from "../../lib/engine/run";
import { buildSampleRowsByCity } from "../../lib/sample-raw-sources";
import { VARIANCE } from "../../lib/engine/variance-names";
import type { SourceRow } from "../../lib/engine/types";

const RUN = "2026-07-12";
const NEXT = "2026-07-13";
const PRIOR = "2026-07-10"; // an Odoo record created before the run day

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
    expect(v?.variance_name).toBe(VARIANCE.FLOOR_DT_NOT_ODOO);
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
    expect(v?.variance_name).toBe(VARIANCE.OPS_DT_ODOO_PENDING);
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
    expect(v?.variance_name).toBe(VARIANCE.FLOOR_DT_NOT_ODOO);
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
    expect(v?.variance_name).toBe(VARIANCE.OPS_ODOO_NO_DT);
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
    expect(v?.variance_name).toBe(VARIANCE.FAILED_DELIVERY);
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
        (x) => x.barcode === canonicalize("FAILED-2") && x.variance_name === VARIANCE.FAILED_DELIVERY
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
    expect(res.variances.some((v) => v.variance_name === VARIANCE.SHEET_ONLY)).toBe(false);
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

  it("Odoo-only, record created on an EARLIER day → Odoo-Only Entry (INFO tally)", () => {
    // Posting dated the run day but the record was created earlier — a late
    // batch-post of an earlier movement whose floor record lives on its own
    // day. Audit tally, not a morning chase item.
    const res = one([{ source: "ODOO", createdOn: RUN, recordCreatedOn: PRIOR }]);
    const v = res.variances.find((x) => x.barcode === canonicalize("ITEM-1"));
    expect(v?.variance_name).toBe(VARIANCE.ODOO_ONLY);
    expect(v?.bucket).toBe("INFO");
    expect(v?.priority).toBe("Info");
    expect(v?.original_priority).toBe("High");
  });

  it("Odoo-only, record CREATED TODAY → Odoo Entry Created Today (REAL chase)", () => {
    // Odoo booked this movement today (record born today) yet no floor source
    // logged it — a genuine same-day gap the floor missed, not benign lag.
    const res = one([{ source: "ODOO", createdOn: RUN, recordCreatedOn: RUN }]);
    const v = res.variances.find((x) => x.barcode === canonicalize("ITEM-1"));
    expect(v?.variance_name).toBe(VARIANCE.ODOO_ONLY_TODAY);
    expect(v?.bucket).toBe("REAL");
    expect(v?.priority).toBe("High");
  });

  it("gate-only → Gate-Only Dispatch (REAL)", () => {
    const res = one([{ source: "PHYSICAL" }]);
    expect(res.variances[0].variance_name).toBe(
      VARIANCE.GATE_ONLY
    );
  });

  it("P+S+D no O → Register/DT Logged — Not in Odoo (REAL)", () => {
    const res = one([
      { source: "PHYSICAL" },
      { source: "SHEET" },
      { source: "DT" },
    ]);
    expect(res.variances[0].variance_name).toBe(
      VARIANCE.FLOOR_DT_NOT_ODOO
    );
  });

  it("P+S+O no D → Odoo Update Pending (INFO, dampened)", () => {
    const res = one([
      { source: "PHYSICAL" },
      { source: "SHEET" },
      { source: "ODOO", createdOn: RUN },
    ]);
    const v = res.variances[0];
    expect(v.variance_name).toBe(VARIANCE.GATE_OPS_ODOO_NO_DT);
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
    expect(res.variances[0].variance_name).toBe(VARIANCE.WRONG_SCAN);
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
        (v) => v.variance_name === VARIANCE.GATE_ONLY
      )
    ).toBe(false);
  });

  it("spare is a BARCODE-level property — a spare tagged on ONE source excludes ALL its rows", () => {
    // The ops sheet tags this barcode "Spare Parts"; the DT row for the SAME
    // barcode carries no spare tag. The whole barcode must be treated as a spare
    // (never flagged 'not in Odoo' / DT-only), and surfaced as a count.
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "SHEET", direction: "OUT", barcode: "CABLEWIRE01", status: "done", jobType: "Spare Parts" }),
        r({ source: "DT", direction: "OUT", barcode: "CABLEWIRE01", status: "done", date: RUN, jobType: "Delivery" }),
      ],
      "MUMBAI"
    );
    expect(res.variances.find((v) => v.barcode === canonicalize("CABLEWIRE01"))).toBeUndefined();
    expect(res.summary.consumable_count).toBeGreaterThanOrEqual(1);
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
    const dc = res.variances.find((v) => v.variance_name === VARIANCE.REPLACEMENT_CONFIRM);
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

describe("OCR-tolerant merge — dampen guard variances from OCR slips", () => {
  const REAL_NAMES = [
    VARIANCE.GATE_ONLY,
    VARIANCE.OPS_ODOO_NO_GATE,
  ];
  const hasReal = (res: ReturnType<typeof runReconciliation>, name: string) =>
    res.variances.some((v) => v.variance_name === name);

  it("(a) ticket match: mangled guard barcode folds into the typed-source item — no false REAL pair", () => {
    // Typed sources carry the correct barcode; the guard's OCR mangled it beyond
    // the canonicalize fold set (barcode agreement < 70%) but the ticket matches.
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "SHEET", direction: "OUT", barcode: "COUCHAAAAA", status: "done", ticketId: "654321" }),
        r({ source: "DT", direction: "OUT", barcode: "COUCHAAAAA", status: "done", date: RUN }),
        r({ source: "ODOO", direction: "OUT", barcode: "COUCHAAAAA", status: "done", createdOn: RUN }),
        // guard's mangled spelling → its own canonical, same ticket:
        r({ source: "PHYSICAL", direction: "OUT", barcode: "C0UCHXYZ99", status: "done", ticketId: "654321" }),
      ],
      "MUMBAI"
    );
    // Both false REAL variances are gone …
    expect(hasReal(res, VARIANCE.GATE_ONLY)).toBe(false);
    expect(hasReal(res, VARIANCE.OPS_ODOO_NO_GATE)).toBe(false);
    // … the mangled orphan view no longer exists …
    expect(res.variances.find((v) => v.barcode === canonicalize("C0UCHXYZ99"))).toBeUndefined();
    // … and whatever remains on the merged item is at most an INFO audit note.
    expect(
      res.variances.filter((v) => v.barcode === canonicalize("COUCHAAAAA")).every((v) => v.bucket === "INFO")
    ).toBe(true);
    expect(res.warnings.some((w) => w.startsWith("OCR merge"))).toBe(true);
  });

  it("(b) fuzzy barcode match (≥70% same-length): merges with no ticket/SO signal", () => {
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "SHEET", direction: "OUT", barcode: "TABLE1234567890", status: "done" }),
        r({ source: "DT", direction: "OUT", barcode: "TABLE1234567890", status: "done", date: RUN }),
        r({ source: "ODOO", direction: "OUT", barcode: "TABLE1234567890", status: "done", createdOn: RUN }),
        // one digit off → 14/15 positions match (≥ 0.70):
        r({ source: "PHYSICAL", direction: "OUT", barcode: "TABLE1234567891", status: "done" }),
      ],
      "MUMBAI"
    );
    for (const name of REAL_NAMES) expect(hasReal(res, name)).toBe(false);
    expect(res.variances.find((v) => v.barcode === canonicalize("TABLE1234567891"))).toBeUndefined();
    expect(res.warnings.some((w) => w.startsWith("OCR merge"))).toBe(true);
  });

  it("(c) SO last-4 + product agreement: weakest signal still merges", () => {
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "SHEET", direction: "OUT", barcode: "CHAIRAAAAA", status: "done", soNumber: "SO-778899", product: "Office Chair" }),
        r({ source: "DT", direction: "OUT", barcode: "CHAIRAAAAA", status: "done", date: RUN }),
        r({ source: "ODOO", direction: "OUT", barcode: "CHAIRAAAAA", status: "done", createdOn: RUN }),
        // different barcode + different SO prefix, but SO last-4 (8899) and
        // product first-token (office) agree:
        r({ source: "PHYSICAL", direction: "OUT", barcode: "CHAIRBBBBB", status: "done", soNumber: "PO-990-8899", product: "Office Chair Grey" }),
      ],
      "MUMBAI"
    );
    for (const name of REAL_NAMES) expect(hasReal(res, name)).toBe(false);
    expect(res.warnings.some((w) => w.startsWith("OCR merge"))).toBe(true);
  });

  it("(d) NEGATIVE: genuinely different item does NOT merge — both real variances stand", () => {
    const res = runReconciliation(
      [
        ...anchor(),
        // A real 'Gate Log Missing' item (typed sources, no guard):
        r({ source: "SHEET", direction: "OUT", barcode: "DESKAAAAAA", status: "done", ticketId: "111111", soNumber: "SO-111111", product: "Desk" }),
        r({ source: "DT", direction: "OUT", barcode: "DESKAAAAAA", status: "done", date: RUN }),
        r({ source: "ODOO", direction: "OUT", barcode: "DESKAAAAAA", status: "done", createdOn: RUN }),
        // A real 'Gate-Only' item — unrelated ticket/SO/product/barcode:
        r({ source: "PHYSICAL", direction: "OUT", barcode: "SHELFBBBBB", status: "done", ticketId: "999999", soNumber: "SO-999999", product: "Shelf" }),
      ],
      "MUMBAI"
    );
    expect(hasReal(res, VARIANCE.GATE_ONLY)).toBe(true);
    expect(hasReal(res, VARIANCE.OPS_ODOO_NO_GATE)).toBe(true);
    expect(res.warnings.some((w) => w.startsWith("OCR merge"))).toBe(false);
  });

  it("(e) exact-match rows reconcile unchanged — merge pass is a no-op", () => {
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "PHYSICAL", direction: "OUT", barcode: "SOFAEXACT1", status: "done" }),
        r({ source: "SHEET", direction: "OUT", barcode: "SOFAEXACT1", status: "done" }),
        r({ source: "DT", direction: "OUT", barcode: "SOFAEXACT1", status: "done", date: RUN }),
        r({ source: "ODOO", direction: "OUT", barcode: "SOFAEXACT1", status: "done", createdOn: RUN }),
      ],
      "MUMBAI"
    );
    expect(res.variances.find((v) => v.barcode === canonicalize("SOFAEXACT1"))).toBeUndefined();
    expect(res.warnings.some((w) => w.startsWith("OCR merge"))).toBe(false);
  });
});

describe("Inward DT quantity-aggregation — DT-missing INFO suppressed for inward", () => {
  const rep = (over: Partial<{ P: boolean; S: boolean; D: boolean; O: boolean }>) => ({
    P: true, S: true, D: true, O: true, ...over,
  });

  it("IN, P+S+O no D (guard present): 'Odoo Update Pending' INFO is suppressed", () => {
    // A PO receipt logged in DT as a quantity → no DT barcode row; Sheet+Odoo
    // (and the guard) still have it. Inward → suppressed, no variance.
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "PHYSICAL", direction: "IN", barcode: "WASH-IN-1", status: "done" }),
        r({ source: "SHEET", direction: "IN", barcode: "WASH-IN-1", status: "done" }),
        r({ source: "ODOO", direction: "IN", barcode: "WASH-IN-1", status: "done", createdOn: RUN }),
      ],
      "MUMBAI"
    );
    expect(res.variances.find((v) => v.barcode === canonicalize("WASH-IN-1"))).toBeUndefined();
  });

  it("IN, S+O no D (no-guard mode): 'DT Missing — Ops & Odoo Agree' INFO is suppressed", () => {
    const res = runReconciliation(
      [
        r({ source: "SHEET", direction: "IN", barcode: "WASH-IN-2", status: "done" }),
        r({ source: "ODOO", direction: "IN", barcode: "WASH-IN-2", status: "done", createdOn: RUN }),
        // run-date anchor (deriveRunDate needs a PHYSICAL/DT row) — no-guard, so
        // build it from DT/Sheet/Odoo (mirrors the existing no-guard test):
        r({ source: "DT", direction: "OUT", barcode: "ANCHOR-DT-2", status: "done", date: RUN }),
        r({ source: "SHEET", direction: "OUT", barcode: "ANCHOR-DT-2", status: "done" }),
        r({ source: "ODOO", direction: "OUT", barcode: "ANCHOR-DT-2", status: "done", createdOn: RUN }),
      ],
      "MUMBAI",
      rep({ P: false })
    );
    expect(res.variances.find((v) => v.barcode === canonicalize("WASH-IN-2"))).toBeUndefined();
  });

  it("NEGATIVE — IN, S+O no P no D (guard reported, missing it): REAL 'Gate Log Missing' still fires", () => {
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "SHEET", direction: "IN", barcode: "WASH-IN-3", status: "done" }),
        r({ source: "ODOO", direction: "IN", barcode: "WASH-IN-3", status: "done", createdOn: RUN }),
      ],
      "MUMBAI"
    );
    const v = res.variances.find((x) => x.barcode === canonicalize("WASH-IN-3"));
    expect(v?.variance_name).toBe(VARIANCE.OPS_ODOO_NO_GATE);
    expect(v?.bucket).toBe("REAL");
  });

  it("NEGATIVE — OUT, P+S+O no D: outward DT-missing INFO still fires (inward-only scope)", () => {
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "PHYSICAL", direction: "OUT", barcode: "WASH-OUT-1", status: "done" }),
        r({ source: "SHEET", direction: "OUT", barcode: "WASH-OUT-1", status: "done" }),
        r({ source: "ODOO", direction: "OUT", barcode: "WASH-OUT-1", status: "done", createdOn: RUN }),
      ],
      "MUMBAI"
    );
    const v = res.variances.find((x) => x.barcode === canonicalize("WASH-OUT-1"));
    expect(v?.variance_name).toBe(VARIANCE.GATE_OPS_ODOO_NO_DT);
    expect(v?.bucket).toBe("INFO");
  });
});

describe("DT enrichment — Odoo-only ticket/ops sourced from Delivery Tracker", () => {
  it("Odoo-only variance takes the DT ticket + ops for the same barcode (cross-direction)", () => {
    const res = runReconciliation(
      [
        ...anchor(),
        // Odoo-only OUT movement — carries Odoo's picking-ref + procurement status.
        r({ source: "ODOO", direction: "OUT", barcode: "WASHER-01", status: "done", createdOn: RUN, ticketId: "BAN/OUT/9", jobType: "ok" }),
        // DT has the same barcode on the IN leg with the real ticket + ops.
        r({ source: "DT", direction: "IN", barcode: "WASHER-01", status: "done", date: RUN, ticketId: "186371", jobType: "Repair" }),
      ],
      "MUMBAI"
    );
    const v = res.variances.find(
      (x) => x.barcode === canonicalize("WASHER-01") && x.direction === "OUT"
    );
    expect(v?.variance_name).toBe(VARIANCE.ODOO_ONLY);
    expect(v?.ticket_id).toBe("186371");
    expect(v?.job_type).toBe("REPAIR");
  });

  it("Odoo-only with no DT row → ticket/ops are blanked (not Odoo's picking-ref)", () => {
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "ODOO", direction: "OUT", barcode: "DRYER-01", status: "done", createdOn: RUN, ticketId: "BAN/OUT/9", jobType: "ok" }),
      ],
      "MUMBAI"
    );
    const v = res.variances.find((x) => x.barcode === canonicalize("DRYER-01"));
    expect(v?.variance_name).toBe(VARIANCE.ODOO_ONLY);
    expect(v?.ticket_id).toBeNull();
    expect(v?.job_type).toBeNull();
  });

  it("NEGATIVE: a mixed (P+S+D) variance keeps its real ticket — not blanked by a DT-lookup miss", () => {
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "PHYSICAL", direction: "OUT", barcode: "TABLE-01", status: "done", ticketId: "PHYS-T1" }),
        r({ source: "SHEET", direction: "OUT", barcode: "TABLE-01", status: "done" }),
        r({ source: "DT", direction: "OUT", barcode: "TABLE-01", status: "done", date: RUN }), // no DT ticket
      ],
      "MUMBAI"
    );
    const v = res.variances.find((x) => x.barcode === canonicalize("TABLE-01"));
    expect(v?.variance_name).toBe(VARIANCE.FLOOR_DT_NOT_ODOO);
    expect(v?.ticket_id).toBe("PHYS-T1"); // kept, since the view is not Odoo-only
  });

  it("NEGATIVE: a DT+Odoo view is not 'Odoo-only' — keeps DT's ticket + ops", () => {
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "DT", direction: "OUT", barcode: "SOFA-01", status: "done", date: RUN, ticketId: "DT-777", jobType: "Delivery" }),
        r({ source: "ODOO", direction: "OUT", barcode: "SOFA-01", status: "done", createdOn: RUN, ticketId: "BAN/OUT/5", jobType: "ok" }),
      ],
      "MUMBAI"
    );
    const v = res.variances.find((x) => x.barcode === canonicalize("SOFA-01"));
    expect(v?.ticket_id).toBe("DT-777");
    expect(v?.job_type).toBe("DELIVERY");
  });
});

describe("Cross-platform status terminology", () => {
  it("normalizeStatus folds the delivery-ops vocabulary into done / pending / not_done", () => {
    // done — the movement physically completed
    for (const t of ["done", "Delivered", "Received", "Picked Up", "Handover", "Dispatched", "Collected"])
      expect(normalizeStatus(t)).toBe("done");
    // not_done — a failed delivery/pickup (unit comes back)
    for (const t of ["Not Delivered", "Undelivered", "RTO", "Return to Origin", "Returned", "Refused", "Cancelled", "Customer Not Available"])
      expect(normalizeStatus(t)).toBe("not_done");
    // pending — in progress
    for (const t of ["pending", "In Transit", "Out for Delivery", "Rescheduled", "Re-attempt", "On Hold"])
      expect(normalizeStatus(t)).toBe("pending");
    // still unrecognized → unknown (unchanged fallback)
    expect(normalizeStatus("frobnicated")).toBe("unknown");
    expect(normalizeStatus("")).toBe("unknown");
  });

  it("an OUT sheet row marked 'RTO' with no IN return leg fires Failed Delivery (was missed as 'unknown')", () => {
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "SHEET", direction: "OUT", barcode: "RTO-1", status: "RTO" }),
      ],
      "MUMBAI"
    );
    const v = res.variances.find((x) => x.barcode === canonicalize("RTO-1"));
    expect(v?.variance_name).toBe(VARIANCE.FAILED_DELIVERY);
    expect(v?.bucket).toBe("REAL");
  });

  it("an OUT 'Returned' row WITH its IN return leg logged is silent (return already recorded)", () => {
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "SHEET", direction: "OUT", barcode: "RET-2", status: "Returned" }),
        r({ source: "SHEET", direction: "IN", barcode: "RET-2", status: "Received" }),
        r({ source: "DT", direction: "IN", barcode: "RET-2", status: "done", date: RUN }),
        r({ source: "ODOO", direction: "IN", barcode: "RET-2", status: "done", createdOn: RUN }),
      ],
      "MUMBAI",
      { P: false, S: true, D: true, O: true }
    );
    expect(
      res.variances.find(
        (x) => x.barcode === canonicalize("RET-2") && x.variance_name === VARIANCE.FAILED_DELIVERY
      )
    ).toBeUndefined();
  });
});

describe("Odoo next-day late entry (1-day buffer)", () => {
  it("floor + DT confirm the day, Odoo posted NEXT day → INFO 'entry made late', not a missing-Odoo REAL", () => {
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "PHYSICAL", direction: "OUT", barcode: "LATE-1", status: "done" }),
        r({ source: "DT", direction: "OUT", barcode: "LATE-1", status: "done", date: RUN }),
        // Odoo posting dated the NEXT day (within the ±1-day pull window).
        r({ source: "ODOO", direction: "OUT", barcode: "LATE-1", status: "done", createdOn: NEXT }),
      ],
      "MUMBAI"
    );
    const v = res.variances.find((x) => x.barcode === canonicalize("LATE-1"));
    expect(v?.variance_name).toBe(VARIANCE.ODOO_POSTED_NEXT_DAY);
    expect(v?.bucket).toBe("INFO");
    expect(v?.priority).toBe("Info");
  });

  it("same-day Odoo posting → no late-entry variance (reconciled, unchanged)", () => {
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "PHYSICAL", direction: "OUT", barcode: "OK-1", status: "done" }),
        r({ source: "DT", direction: "OUT", barcode: "OK-1", status: "done", date: RUN }),
        r({ source: "ODOO", direction: "OUT", barcode: "OK-1", status: "done", createdOn: RUN }),
      ],
      "MUMBAI"
    );
    expect(res.variances.find((x) => x.barcode === canonicalize("OK-1"))).toBeUndefined();
  });
});
