import { describe, expect, it } from "vitest";
import { parseDate, deriveRunDate, addDays } from "../../lib/engine/dates";
import { canonicalize, isValidBarcode, isSpareOrConsumable } from "../../lib/engine/barcode";
import { normalizeStatus } from "../../lib/engine/util";
import { runAllCities, runReconciliation } from "../../lib/engine/run";
import { isCityOff } from "../../lib/engine/schedule";
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

  it("no-register + no-DT city: reconciles Sheet+Odoo against the caller's fallback date", () => {
    // Register not uploaded and DT quiet → nothing to derive the run date from.
    // With the pipeline's intended date supplied, the remaining sources still
    // reconcile (previously this threw and killed the whole run).
    const rows = [
      r({ source: "SHEET", direction: "OUT", barcode: "SOFANOREG1", status: "done" }),
      r({ source: "ODOO", direction: "OUT", barcode: "SOFANOREG1", status: "done", createdOn: RUN }),
    ];
    const rep = { P: false, S: true, D: false, O: true };
    // without a fallback the old contract still holds…
    expect(() => runReconciliation(rows, "MUMBAI", rep)).toThrow(/Run-date derivation failed/);
    // …with the fallback it reconciles against the requested day.
    const res = runReconciliation(rows, "MUMBAI", rep, new Set(), RUN);
    expect(res.date).toBe(RUN);
    expect(res.summary.movements).toBe(1);
    expect(res.warnings.some((w) => w.includes("using the requested date"))).toBe(true);
  });

  it("weekly-off calendar: Thursday off for MUM/HYD/PUNE only", () => {
    // 2026-07-23 was a Thursday; 2026-07-24 a Friday.
    for (const city of ["MUMBAI", "HYDERABAD", "PUNE"] as const) {
      expect(isCityOff(city, "2026-07-23")).toBe(true);
      expect(isCityOff(city, "2026-07-24")).toBe(false);
    }
    for (const city of ["DELHI", "BANGALORE"] as const) {
      expect(isCityOff(city, "2026-07-23")).toBe(false);
    }
    expect(isCityOff("MUMBAI", "garbage")).toBe(false);
  });

  it("off day: Odoo-only created-today stays INFO for a closed warehouse, REAL for an open one", () => {
    const THU = "2026-07-23";
    const mk = (city: "MUMBAI" | "BANGALORE") => [
      // anchor rows dated the Thursday so run-date derivation lands on it
      r({ source: "PHYSICAL", direction: "OUT", barcode: "ANCHOR-OK-9", status: "done", date: THU }),
      r({ source: "SHEET", direction: "OUT", barcode: "ANCHOR-OK-9", status: "done", date: THU }),
      r({ source: "DT", direction: "OUT", barcode: "ANCHOR-OK-9", status: "done", date: THU }),
      r({ source: "ODOO", direction: "OUT", barcode: "ANCHOR-OK-9", status: "done", createdOn: THU, date: THU }),
      r({ source: "ODOO", direction: "OUT", barcode: "OFFDAYTV01", status: "done", createdOn: THU, recordCreatedOn: THU, soNumber: "ON-RET-X-42424", ticketId: "X/OUT/1", date: THU }),
    ];
    const mum = runReconciliation(mk("MUMBAI"), "MUMBAI");
    const vMum = mum.variances.find((x) => x.barcode === canonicalize("OFFDAYTV01"));
    expect(vMum?.variance_name).toBe(VARIANCE.ODOO_ONLY);
    expect(vMum?.bucket).toBe("INFO");
    expect(mum.warnings.some((w) => w.includes("weekly off"))).toBe(true);

    const ban = runReconciliation(mk("BANGALORE"), "BANGALORE");
    const vBan = ban.variances.find((x) => x.barcode === canonicalize("OFFDAYTV01"));
    expect(vBan?.variance_name).toBe(VARIANCE.ODOO_ONLY_TODAY);
    expect(vBan?.bucket).toBe("REAL");
  });

  it("one broken city cannot take down the others (runAllCities isolation)", () => {
    const rowsByCity = {
      MUMBAI: [
        r({ source: "PHYSICAL", direction: "OUT", barcode: "GOODCITY01", status: "done", date: RUN }),
        r({ source: "SHEET", direction: "OUT", barcode: "GOODCITY01", status: "done" }),
        r({ source: "DT", direction: "OUT", barcode: "GOODCITY01", status: "done", date: RUN }),
        r({ source: "ODOO", direction: "OUT", barcode: "GOODCITY01", status: "done", createdOn: RUN }),
      ],
      // garbage dates, and no fallback passed → this city throws internally
      DELHI: [r({ source: "PHYSICAL", direction: "OUT", barcode: "BADCITY001", status: "done", date: "garbage" })],
    } as Parameters<typeof runAllCities>[0];
    const run = runAllCities(rowsByCity);
    expect(run.perCity.map((c) => c.city)).toEqual(["MUMBAI"]);
    expect(run.skipped).toHaveLength(1);
    expect(run.skipped[0].city).toBe("DELHI");
    expect(run.skipped[0].error).toMatch(/Run-date derivation failed/);
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
    r({ source: "PHYSICAL", direction: "OUT", barcode: "FUTEST2301001", status: "done", date: RUN }),
    r({ source: "ODOO", direction: "OUT", barcode: "FUTEST2301001", status: "done", createdOn }),
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
        r({ source: "SHEET", direction: "OUT", barcode: "UNIT-2", status: "done" }),
        r({ source: "DT", direction: "OUT", barcode: "UNIT-2", status: "done", date: RUN }),
      ],
      "MUMBAI",
      rep({ P: false })
    );
    const v = res.variances.find((x) => x.barcode === canonicalize("UNIT-2"));
    expect(v?.variance_name).toBe(VARIANCE.FLOOR_DT_NOT_ODOO);
    expect(v?.bucket).toBe("REAL");
  });

  it("guard reported: same pattern stays the 4-source INFO cross-check", () => {
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "SHEET", direction: "OUT", barcode: "UNIT-2", status: "done" }),
        r({ source: "DT", direction: "OUT", barcode: "UNIT-2", status: "done", date: RUN }),
      ],
      "MUMBAI"
    );
    const v = res.variances.find((x) => x.barcode === canonicalize("UNIT-2"));
    expect(v?.variance_name).toBe(VARIANCE.OPS_DT_ODOO_PENDING);
    expect(v?.bucket).toBe("INFO");
  });

  it("Odoo outage: absence variances against Odoo are silenced", () => {
    const res = runReconciliation(
      [
        r({ source: "SHEET", direction: "OUT", barcode: "UNIT-3", status: "done" }),
        r({ source: "DT", direction: "OUT", barcode: "UNIT-3", status: "done", date: RUN }),
      ],
      "MUMBAI",
      rep({ P: false, O: false })
    );
    expect(
      res.variances.find((x) => x.barcode === canonicalize("UNIT-3"))
    ).toBeUndefined();
  });

  it("sheet not filled in (unreported): DT-only does NOT become Fake Scan Risk", () => {
    const res = runReconciliation(
      [
        r({ source: "DT", direction: "OUT", barcode: "UNIT-4", status: "done", date: RUN }),
        // Odoo reported for the city via another barcode:
        r({ source: "ODOO", direction: "OUT", barcode: "OTHER-9", status: "done", createdOn: RUN }),
      ],
      "MUMBAI",
      rep({ P: false, S: false })
    );
    const v = res.variances.find((x) => x.barcode === canonicalize("UNIT-4"));
    // Floor sources both unreported → corroboration vacuous → Odoo-missing REAL.
    expect(v?.variance_name).toBe(VARIANCE.FLOOR_DT_NOT_ODOO);
  });

  it("no-guard mode: Sheet+Odoo agree, DT missing → INFO (not Gate Log Missing)", () => {
    const res = runReconciliation(
      [
        r({ source: "SHEET", direction: "OUT", barcode: "UNIT-5", status: "done" }),
        r({ source: "ODOO", direction: "OUT", barcode: "UNIT-5", status: "done", createdOn: RUN }),
        // date anchor (deriveRunDate needs a PHYSICAL/DT row):
        r({ source: "DT", direction: "OUT", barcode: "ANCHOR-DT-1", status: "done", date: RUN }),
        r({ source: "SHEET", direction: "OUT", barcode: "ANCHOR-DT-1", status: "done" }),
        r({ source: "ODOO", direction: "OUT", barcode: "ANCHOR-DT-1", status: "done", createdOn: RUN }),
      ],
      "MUMBAI",
      rep({ P: false })
    );
    const v = res.variances.find((x) => x.barcode === canonicalize("UNIT-5"));
    expect(v?.variance_name).toBe(VARIANCE.OPS_ODOO_NO_DT);
    expect(v?.bucket).toBe("INFO");
  });
});

describe("Only COMPLETED movements reconcile (done vs not-done)", () => {
  // The bug these cover: the failed-delivery rule used to require EVERY
  // source's status to be not_done. DT, Odoo and the guard register all
  // hard-code "done" (each filters to completed rows upstream), so a failed
  // delivery the guard had logged on its way out defeated the test and was
  // classified as a REAL loss by ladder rung 3.
  it("DONE WINS: one source says done, so the unit is done and reconciles", () => {
    // The owner's rule (2026-08-02): a unit is done or it is not, and the books
    // cannot disagree about that and both be right. Here the gate register
    // recorded the unit crossing and the sheet's inward leg says Received —
    // two completion claims — so the not-done OUT line does not remove the
    // unit from reconciliation. It ladders on the evidence like any other.
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "PHYSICAL", direction: "OUT", barcode: "GATEFAIL01", status: "done", date: RUN }),
        r({ source: "SHEET", direction: "OUT", barcode: "GATEFAIL01", status: "Not Delivered" }),
        r({ source: "SHEET", direction: "IN", barcode: "GATEFAIL01", status: "Received" }),
      ],
      "MUMBAI"
    );
    const hits = res.variances.filter((x) => x.barcode === canonicalize("GATEFAIL01"));
    // Whatever it raises, the retired failed-delivery name is never among them.
    expect(hits.map((x) => x.variance_name)).not.toContain(VARIANCE.FAILED_DELIVERY);
    // And done-wins means this unit was NOT excluded as not-done.
    expect(res.warnings.some((w) => w.includes("done-tasks-only"))).toBe(false);
  });


  it("same case, return never logged: still nothing — done-tasks-only (owner, 2026-08-01)", () => {
    // This used to raise FAILED_DELIVERY (REAL). The owner's rule retired it:
    // reconciliation checks that COMPLETED movements are marked everywhere; a
    // task the sheet says did not happen is not a movement. The not-done sheet
    // row is excluded at the mouth of the engine, and the guard's OUT row for
    // the same unit merges/ladders on its own merits.
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "SHEET", direction: "OUT", barcode: "GATEFAIL02", status: "Not Delivered" }),
      ],
      "MUMBAI"
    );
    const hits = res.variances.filter((x) => x.barcode === canonicalize("GATEFAIL02"));
    expect(hits).toHaveLength(0);
    expect(res.warnings.some((w) => w.includes("done-tasks-only"))).toBe(true);
  });

  it("sheet Not Delivered + Odoo posted → at most an Odoo-side INFO, never a REAL", () => {
    // Ghost Dispatch is retired with the done-tasks-only rule. The not-done
    // sheet row leaves reconciliation; what remains is an Odoo posting with no
    // completed floor record, which the Odoo-only branches already grade INFO.
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "SHEET", direction: "OUT", barcode: "DISAGREE01", status: "Not Delivered" }),
        r({ source: "ODOO", direction: "OUT", barcode: "DISAGREE01", status: "done", createdOn: RUN }),
      ],
      "MUMBAI"
    );
    const hits = res.variances.filter((x) => x.barcode === canonicalize("DISAGREE01"));
    for (const h of hits) {
      expect(h.variance_name).not.toBe(VARIANCE.SHEET_NOT_DONE_BUT_POSTED);
      expect(h.bucket).toBe("INFO");
    }
  });

  it("same via DT: the done DT row ladders on its own, no Ghost Dispatch", () => {
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "SHEET", direction: "OUT", barcode: "DISAGREE02", status: "Not Delivered" }),
        r({ source: "DT", direction: "OUT", barcode: "DISAGREE02", status: "done", date: RUN }),
      ],
      "MUMBAI"
    );
    const hits = res.variances.filter((x) => x.barcode === canonicalize("DISAGREE02"));
    for (const h of hits) expect(h.variance_name).not.toBe(VARIANCE.SHEET_NOT_DONE_BUT_POSTED);
  });

  it("a sheet row with BOTH a done and a not-done status is treated as done (ladder runs)", () => {
    // Two ops-sheet lines for the same unit, one delivered. Ambiguous, but a
    // completion claim exists, so it must not be waved through as a failure.
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "SHEET", direction: "OUT", barcode: "MIXEDSTAT1", status: "Not Delivered" }),
        r({ source: "SHEET", direction: "OUT", barcode: "MIXEDSTAT1", status: "Delivered" }),
      ],
      "MUMBAI"
    );
    const names = res.variances
      .filter((x) => x.barcode === canonicalize("MIXEDSTAT1"))
      .map((x) => x.variance_name);
    expect(names).not.toContain(VARIANCE.FAILED_DELIVERY);
    expect(names).not.toContain(VARIANCE.SHEET_NOT_DONE_BUT_POSTED);
  });
});

describe("Failed delivery & PP boxes (ops-practice rules)", () => {
  it("OUT marked Not Delivered, no return leg → nothing (done-tasks-only)", () => {
    // Was a REAL "Unclosed Return" chase. Retired by the owner's rule: the
    // sheet itself says the task did not complete, so there is no movement to
    // reconcile. The row is counted in the run's warnings, not the queue.
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "SHEET", direction: "OUT", barcode: "FAILED-1", status: "Not Delivered" }),
      ],
      "MUMBAI"
    );
    expect(res.variances.filter((x) => x.barcode === canonicalize("FAILED-1"))).toHaveLength(0);
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

  it('ops-sheet item name "Not Found" → spare/consumable, not a loss', () => {
    // The floor types a description into the barcode column and the product
    // lookup fails, so the item name reads "Not Found". Measured on live data:
    // 217 of 219 such rows appeared in no other system and were real spares.
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "SHEET", direction: "IN", barcode: "WP water seal - 13", product: "Not Found", status: "Received" }),
        r({ source: "SHEET", direction: "IN", barcode: "Spin Motor - 3", product: "Not Found", status: "Received" }),
      ],
      "MUMBAI"
    );
    expect(res.summary.consumable_count).toBe(2);
    expect(res.count_in.sheet_total).toBe(2);
    expect(res.variances.some((v) => v.barcode === canonicalize("WP water seal - 13"))).toBe(false);
    expect(res.variances.some((v) => v.barcode === canonicalize("Spin Motor - 3"))).toBe(false);
  });

  it('"Not Found" does NOT reclassify a barcode a serialized system knows', () => {
    // The 2 real exceptions on live data: a genuine Odoo lot serial whose sheet
    // line simply had a blank product column. Diverting it to counts would
    // erase a real receipt from reconciliation.
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "SHEET", direction: "IN", barcode: "FUCQPU26070002", product: "Not Found", status: "Received" }),
        r({ source: "ODOO", direction: "IN", barcode: "FUCQPU26070002", product: "# Luna Wardrobe", status: "done", createdOn: RUN }),
      ],
      "MUMBAI"
    );
    // Still a real tracked unit: counted as a movement, not a consumable.
    expect(res.summary.consumable_count).toBe(0);
    expect(res.summary.movements).toBeGreaterThan(1);
  });

  it("PP box named in the ITEM column (not the barcode) is still a PP box", () => {
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "SHEET", direction: "OUT", barcode: "OTINKD25041071", product: "# PP BOX - Refrigerator SD", status: "done" }),
      ],
      "MUMBAI"
    );
    expect(res.summary.pp_box_count).toBe(1);
    expect(res.variances.some((v) => v.barcode === canonicalize("OTINKD25041071"))).toBe(false);
  });

  it("the remarks column can mark a row as a spare", () => {
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "SHEET", direction: "IN", barcode: "ABC12345XY", product: "Bracket", remarks: "spare part", status: "Received" }),
      ],
      "MUMBAI"
    );
    expect(res.summary.consumable_count).toBe(1);
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
    expect(res.count_out.sheet_total).toBe(3);
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
          // A realistic 13-char label: P-only fixtures now pass through the
          // OCR plausibility gate exactly like production barcodes do.
          r({ direction: "OUT", barcode: "FUTEST2301001", status: "done", ...p })
        ),
      ],
      "MUMBAI"
    );

  it("Odoo-only, record created on an EARLIER day → Odoo-Only Entry (INFO tally)", () => {
    // Posting dated the run day but the record was created earlier — a late
    // batch-post of an earlier movement whose floor record lives on its own
    // day. Audit tally, not a morning chase item.
    const res = one([{ source: "ODOO", createdOn: RUN, recordCreatedOn: PRIOR }]);
    const v = res.variances.find((x) => x.barcode === canonicalize("FUTEST2301001"));
    expect(v?.variance_name).toBe(VARIANCE.ODOO_ONLY);
    expect(v?.bucket).toBe("INFO");
    expect(v?.priority).toBe("Info");
    expect(v?.original_priority).toBe("High");
  });

  it("Odoo-only, record CREATED TODAY, customer flow → Odoo Entry Created Today (REAL chase)", () => {
    // Odoo booked this CUSTOMER movement today (record born today, sale order
    // present) yet no floor source logged it — a genuine same-day gap the floor
    // missed, not benign lag.
    const res = one([
      { source: "ODOO", createdOn: RUN, recordCreatedOn: RUN, soNumber: "ON-RET-MUM-42424", ticketId: "MUM/OUT/12345" },
    ]);
    const v = res.variances.find((x) => x.barcode === canonicalize("FUTEST2301001"));
    expect(v?.variance_name).toBe(VARIANCE.ODOO_ONLY_TODAY);
    expect(v?.bucket).toBe("REAL");
    expect(v?.priority).toBe("High");
  });

  it("Odoo-only created today, NO sale order (vendor PO receipt) → INFO, not REAL", () => {
    // Vendor receipts serialize stock IN Odoo at receipt — the floor logs the
    // truck, never each new serial. Not a per-barcode floor flow → never a loss.
    const res = one([
      { source: "ODOO", createdOn: RUN, recordCreatedOn: RUN, ticketId: "BAN/IN/24136" },
    ]);
    const v = res.variances.find((x) => x.barcode === canonicalize("FUTEST2301001"));
    expect(v?.variance_name).toBe(VARIANCE.ODOO_ONLY);
    expect(v?.bucket).toBe("INFO");
  });

  it("Odoo-only created today, /INT/ internal transfer → INFO, not REAL", () => {
    const res = one([
      { source: "ODOO", createdOn: RUN, recordCreatedOn: RUN, soNumber: "ON-RET-PUN-11111", ticketId: "PUN/INT/00123" },
    ]);
    const v = res.variances.find((x) => x.barcode === canonicalize("FUTEST2301001"));
    expect(v?.variance_name).toBe(VARIANCE.ODOO_ONLY);
    expect(v?.bucket).toBe("INFO");
  });

  it("BULK collapse: one SO posted as many created-today units → ONE chase item, rest INFO", () => {
    // A vendor truck / B2B bulk dispatch books many serials on one sale order
    // (2026-07-21: a 157-unit SO produced 157 HIGH rows). One business event =
    // one representative REAL row; the other units fold into the INFO tally.
    const bulk = Array.from({ length: 6 }, (_, i) =>
      r({ source: "ODOO", direction: "OUT", barcode: `BULKTV260700${i}${i}`, status: "done", createdOn: RUN, recordCreatedOn: RUN, soNumber: "ON-RET-BAN-77777", ticketId: "BAN/OUT/58096" })
    );
    const res = runReconciliation([...anchor(), ...bulk], "BANGALORE");
    const real = res.variances.filter((v) => v.variance_name === VARIANCE.ODOO_ONLY_TODAY);
    const folded = res.variances.filter(
      (v) => v.variance_name === VARIANCE.ODOO_ONLY && v.so_number === "ON-RET-BAN-77777"
    );
    expect(real).toHaveLength(1);
    expect(real[0].bucket).toBe("REAL");
    expect(real[0].note).toContain("6 units");
    expect(folded).toHaveLength(5);
    expect(folded.every((v) => v.bucket === "INFO")).toBe(true);
    // …while a small group (below the bulk threshold) stays per-unit REAL.
    const small = Array.from({ length: 2 }, (_, i) =>
      r({ source: "ODOO", direction: "OUT", barcode: `SMALLWM2607${i}${i}`, status: "done", createdOn: RUN, recordCreatedOn: RUN, soNumber: "ON-RET-BAN-88888", ticketId: "BAN/OUT/58097" })
    );
    const res2 = runReconciliation([...anchor(), ...small], "BANGALORE");
    expect(res2.variances.filter((v) => v.variance_name === VARIANCE.ODOO_ONLY_TODAY)).toHaveLength(2);
  });

  it("Odoo-only created today but floor logged the unit on an ADJACENT day → INFO (backlog entry)", () => {
    // The clerk typed up an earlier day's movement today — the floor documented
    // it on its own day (recentFloor), so this is a late entry, not a loss.
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "ODOO", direction: "OUT", barcode: "FUTEST2301001", status: "done", createdOn: RUN, recordCreatedOn: RUN, soNumber: "ON-RET-MUM-42424", ticketId: "MUM/OUT/12345" }),
      ],
      "MUMBAI",
      undefined,
      new Set([canonicalize("FUTEST2301001")])
    );
    const v = res.variances.find((x) => x.barcode === canonicalize("FUTEST2301001"));
    expect(v?.variance_name).toBe(VARIANCE.ODOO_ONLY);
    expect(v?.bucket).toBe("INFO");
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
        r({ source: "PHYSICAL", direction: "OUT", barcode: "FUTEST2301001", status: "done" }),
        r({ source: "DT", direction: "OUT", barcode: "FUTEST2301001", status: "non_match" }),
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
        r({ source: "PHYSICAL", direction: "OUT", barcode: "FUTEST2301001", status: "done" }),
        r({ source: "DT", direction: "OUT", barcode: "FUTEST2301001", status: "pending" }),
        r({ source: "DT", direction: "OUT", barcode: "FUTEST2301001", status: "pending" }),
      ],
      "MUMBAI"
    );
    expect(
      res.variances.find((v) => v.barcode === canonicalize("FUTEST2301001"))
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
        r({ source: "PHYSICAL", direction: "OUT", barcode: "FUTEST2301001", status: "done", soNumber: "SO-9" }),
        r({ source: "DT", direction: "OUT", barcode: "FUTEST2301001", status: "done", soNumber: "SO-9" }),
        r({ source: "PHYSICAL", direction: "IN", barcode: "FUTEST2301001", status: "done", soNumber: "SO-9" }),
        r({ source: "SHEET", direction: "IN", barcode: "FUTEST2301001", status: "done", soNumber: "SO-9" }),
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
        // Realistic digits so the plausibility gate (a production behaviour)
        // does not park the fixture before the ladder can see it.
        r({ source: "PHYSICAL", direction: "OUT", barcode: "SHELF2509012", status: "done", ticketId: "999999", soNumber: "SO-999999", product: "Shelf" }),
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

  it("(f) multi-item delivery: shared ticket, SO last-4 disambiguates each mangled guard row", () => {
    // A real failure mode (BAN ticket 1188659): one delivery, several line items,
    // ALL sharing the ticket. Each guard barcode is a 1-char OCR drop of the
    // typed barcode (13 vs 14 chars → barcode fuzzy CAN'T fire), and the guard
    // SO is bare ("84808") vs the typed "ON-RET-BAN-84808". Only the SO last-4
    // tells the items apart — exact-ticket alone ties all of them. Both guard
    // rows must fold in; neither may raise a 'Missing from Gate Register' pair.
    const item = (bcTyped: string, bcGuard: string, so: string, product: string) => [
      r({ source: "SHEET", direction: "OUT", barcode: bcTyped, status: "done", ticketId: "1188659", soNumber: `ON-RET-BAN-${so}`, product }),
      r({ source: "DT", direction: "OUT", barcode: bcTyped, status: "done", date: RUN, ticketId: "1188659", soNumber: `ON-RET-BAN-${so}` }),
      r({ source: "ODOO", direction: "OUT", barcode: bcTyped, status: "done", createdOn: RUN }),
      r({ source: "PHYSICAL", direction: "OUT", barcode: bcGuard, status: "done", ticketId: "1188659", soNumber: so, product }),
    ];
    const res = runReconciliation(
      [
        ...anchor(),
        ...item("APC7VY25040053", "APC7Y25040053", "84807", "Refrigerator"),
        ...item("AP8IS722024068", "AP8IS72202068", "84808", "Washing Machine"),
      ],
      "BANGALORE"
    );
    // Both mangled guard orphans folded in — no false Gate pair for either item.
    expect(hasReal(res, VARIANCE.OPS_ODOO_NO_GATE)).toBe(false);
    expect(hasReal(res, VARIANCE.GATE_ONLY)).toBe(false);
    expect(res.variances.find((v) => v.barcode === canonicalize("APC7Y25040053"))).toBeUndefined();
    expect(res.variances.find((v) => v.barcode === canonicalize("AP8IS72202068"))).toBeUndefined();
    // The merged items are reconciled or at most INFO (barcode text still differs).
    for (const bc of ["APC7VY25040053", "AP8IS722024068"]) {
      expect(
        res.variances.filter((v) => v.barcode === canonicalize(bc)).every((v) => v.bucket === "INFO")
      ).toBe(true);
    }
    expect(res.warnings.filter((w) => w.startsWith("OCR merge")).length).toBe(2);
  });

  it("(g) pure-digit guard fragment that matches nothing is DROPPED, not a Gate-Only REAL", () => {
    // "3040373"-style partial register reads: typed sources never produce
    // pure-digit barcodes, so an unmerged digits-only guard orphan is OCR
    // debris — dropped with an audit warning instead of raising a false REAL.
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "PHYSICAL", direction: "IN", barcode: "3040373", status: "done" }),
      ],
      "MUMBAI"
    );
    expect(res.variances.find((v) => v.barcode === "3040373")).toBeUndefined();
    expect(res.warnings.some((w) => w.startsWith("OCR fragment dropped"))).toBe(true);
  });

  it("(h) pure-digit guard row that CAN merge via SO still merges (drop only hits unmatched orphans)", () => {
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "SHEET", direction: "OUT", barcode: "APMYUX22050333", status: "done", soNumber: "ON-RET-BAN-66892", product: "Microwave" }),
        r({ source: "DT", direction: "OUT", barcode: "APMYUX22050333", status: "done", date: RUN, soNumber: "ON-RET-BAN-66892" }),
        r({ source: "ODOO", direction: "OUT", barcode: "APMYUX22050333", status: "done", createdOn: RUN }),
        // guard OCR caught only a numeric tail, but the SO digits match uniquely:
        r({ source: "PHYSICAL", direction: "OUT", barcode: "2205033", status: "done", soNumber: "66892", product: "Microwave" }),
      ],
      "BANGALORE"
    );
    expect(res.warnings.some((w) => w.startsWith("OCR merge"))).toBe(true);
    expect(res.variances.find((v) => v.barcode === "2205033")).toBeUndefined();
    // merged item: at most INFO (barcode text differs)
    expect(
      res.variances.filter((v) => v.barcode === canonicalize("APMYUX22050333")).every((v) => v.bucket === "INFO")
    ).toBe(true);
  });

  it("(i) single-source-only row floor-logged on an ADJACENT day → INFO wrong-day echo, not REAL", () => {
    // The register page for this date carried a line whose movement the floor
    // systems documented on the day before (page spanning days / late write-up).
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "PHYSICAL", direction: "OUT", barcode: "SOFAECHO12", status: "done" }),
      ],
      "MUMBAI",
      undefined,
      new Set([canonicalize("SOFAECHO12")])
    );
    const v = res.variances.find((x) => x.barcode === canonicalize("SOFAECHO12"));
    expect(v?.variance_name).toBe(VARIANCE.ADJACENT_DAY);
    expect(v?.bucket).toBe("INFO");
    // …and WITHOUT the adjacent-day evidence the same shape stays a REAL Gate-Only.
    const res2 = runReconciliation(
      [
        ...anchor(),
        r({ source: "PHYSICAL", direction: "OUT", barcode: "SOFAECHO12", status: "done" }),
      ],
      "MUMBAI"
    );
    const v2 = res2.variances.find((x) => x.barcode === canonicalize("SOFAECHO12"));
    expect(v2?.variance_name).toBe(VARIANCE.GATE_ONLY);
    expect(v2?.bucket).toBe("REAL");
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

  it("IN, S+O no P no D (guard reported, missing it): 'Missing from Gate Register' fires as INFO hygiene", () => {
    // Ops sheet + Odoo both document the movement — only the handwritten
    // register (or its OCR) missed the line. Gate-log hygiene, not a loss
    // (measured 2026-07-20: 220/230 such rows even had a DT scan).
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
    expect(v?.bucket).toBe("INFO");
    expect(v?.priority).toBe("Info");
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

  it("an OUT sheet row marked 'RTO' raises nothing — done-tasks-only", () => {
    // RTO (return to origin) is a failed delivery. It used to fire the REAL
    // "Unclosed Return" chase; the owner's rule retired it — a task that did
    // not complete is not a movement, so it is excluded and suppressed, never
    // raised. The status-vocabulary point this test guarded still stands:
    // "RTO" must normalize to not_done, not fall through to "unknown".
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "SHEET", direction: "OUT", barcode: "RTO-1", status: "RTO" }),
      ],
      "MUMBAI"
    );
    expect(res.variances.filter((x) => x.barcode === canonicalize("RTO-1"))).toHaveLength(0);
    expect(res.warnings.some((w) => w.includes("done-tasks-only"))).toBe(true);
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

describe("Per-source presence flags (migration 0013)", () => {
  // This invariant is what licenses the all-false sentinel: a view only exists
  // because some source produced a row for it, so the engine can never emit a
  // row with nothing present. If this ever fails, "all four false = written
  // before 0013" is unsound and the migration comment is a lie.
  it("every emitted row has at least one source present, across all sample cities", () => {
    const byCity = buildSampleRowsByCity(RUN);
    let checked = 0;
    for (const [city, rows] of Object.entries(byCity)) {
      const res = runReconciliation(rows, city as never);
      for (const v of res.variances) {
        expect(
          v.present.P || v.present.S || v.present.D || v.present.O,
          `${city} ${v.barcode} ${v.variance_name} had no source present`
        ).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("flags match the ladder's presence pattern", () => {
    const gateOnly = runReconciliation(
      [...anchor(), r({ source: "PHYSICAL", direction: "OUT", barcode: "PONLY2507001", status: "done" })],
      "MUMBAI"
    ).variances.find((x) => x.barcode === canonicalize("PONLY2507001"));
    expect(gateOnly?.variance_name).toBe(VARIANCE.GATE_ONLY);
    expect(gateOnly?.present).toEqual({ P: true, S: false, D: false, O: false });

    const floorDt = runReconciliation(
      [
        ...anchor(),
        r({ source: "PHYSICAL", direction: "OUT", barcode: "PSD-1", status: "done" }),
        r({ source: "SHEET", direction: "OUT", barcode: "PSD-1", status: "done" }),
        r({ source: "DT", direction: "OUT", barcode: "PSD-1", status: "done" }),
      ],
      "MUMBAI"
    ).variances.find((x) => x.barcode === canonicalize("PSD-1"));
    expect(floorDt?.variance_name).toBe(VARIANCE.FLOOR_DT_NOT_ODOO);
    expect(floorDt?.present).toEqual({ P: true, S: true, D: true, O: false });
  });

  // The highest-value case. mergeGuardPresence mutates target.P AFTER the views
  // are built, so a flag snapshotted during buildViews would report "no gate
  // record" for exactly the unit the OCR merge just fixed.
  it("presence is read after the OCR-orphan merge, not during view construction", () => {
    // Same fixture as the OCR-merge suite's case (a): typed sources carry the
    // correct barcode, the guard's spelling is mangled beyond the canonicalize
    // fold set, and only the ticket links them.
    const res = runReconciliation(
      [
        ...anchor(),
        r({ source: "SHEET", direction: "OUT", barcode: "COUCHAAAAA", status: "done", ticketId: "654321" }),
        r({ source: "DT", direction: "OUT", barcode: "COUCHAAAAA", status: "done", date: RUN }),
        r({ source: "ODOO", direction: "OUT", barcode: "COUCHAAAAA", status: "done", createdOn: RUN }),
        r({ source: "PHYSICAL", direction: "OUT", barcode: "C0UCHXYZ99", status: "done", ticketId: "654321" }),
      ],
      "MUMBAI"
    );
    expect(res.warnings.some((w) => w.startsWith("OCR merge"))).toBe(true);
    // The merged unit reconciles cleanly, so it raises no row of its own — the
    // proof the merge landed is that the guard-only orphan raised none either.
    expect(res.variances.find((x) => x.barcode === canonicalize("C0UCHXYZ99"))).toBeUndefined();
    // Any row that does survive on the merged canonical must show the gate as
    // present; a build-time snapshot of P would report false here.
    for (const v of res.variances.filter((x) => x.barcode === canonicalize("COUCHAAAAA"))) {
      expect(v.present.P, "guard presence must survive the OCR merge").toBe(true);
    }
  });

  it("stamps `reported` on every row, including paths that bypass applyBucket", () => {
    const byCity = buildSampleRowsByCity(RUN);
    const rows = byCity.MUMBAI ?? [];
    const res = runReconciliation(rows, "MUMBAI", { P: false, S: true, D: true, O: true });
    expect(res.variances.length).toBeGreaterThan(0);
    for (const v of res.variances) {
      expect(v.reported, `${v.variance_name} lost the reported stamp`).toEqual({
        P: false, S: true, D: true, O: true,
      });
    }
  });
});
