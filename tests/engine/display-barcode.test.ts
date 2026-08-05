import { describe, expect, it } from "vitest";
import { displayBarcode } from "../../lib/engine/views";
import { canonicalize } from "../../lib/engine/barcode";
import type { BarcodeView, SourcePresence } from "../../lib/engine/types";

const absent = (): SourcePresence => ({ present: false, count: 0, statuses: [], rawBarcodes: [] });
const saw = (...raw: string[]): SourcePresence => ({
  present: true,
  count: raw.length,
  statuses: ["done"],
  rawBarcodes: raw,
});

const view = (over: Partial<BarcodeView> = {}): BarcodeView =>
  ({
    canonical: "FUMY6B23070029",
    direction: "OUT",
    city: "HYDERABAD",
    P: absent(), S: absent(), D: absent(), O: absent(),
    odooSameDay: false, odooNextDay: false, odooCreatedToday: false,
    soNumber: null, ticketId: null, customer: null, product: null,
    jobType: null, dtNonMatch: false, duplicateSources: [], date: "2026-08-04",
    ...over,
  }) as BarcodeView;

describe("displayBarcode — the label a human can search for", () => {
  it("returns Odoo's spelling when Odoo saw it", () => {
    // The reported case: Odoo's serial is AP8IS725090229 and the fold turns it
    // into AP815725090229, which returns "no product move" in Odoo.
    const v = view({
      canonical: "AP815725090229",
      O: saw("AP8IS725090229"),
    });
    expect(displayBarcode(v)).toBe("AP8IS725090229");
    expect(canonicalize(displayBarcode(v))).toBe(v.canonical); // still folds to the key
  });

  it("prefers Odoo, then DT, then the sheet, then the guard register", () => {
    const all = view({
      O: saw("ODOO-SPELLING"), D: saw("DT-SPELLING"),
      S: saw("SHEET-SPELLING"), P: saw("GUARD-SPELLING"),
    });
    expect(displayBarcode(all)).toBe("ODOO-SPELLING");
    expect(displayBarcode(view({ D: saw("DT-SPELLING"), S: saw("SHEET-SPELLING"), P: saw("GUARD-SPELLING") }))).toBe("DT-SPELLING");
    expect(displayBarcode(view({ S: saw("SHEET-SPELLING"), P: saw("GUARD-SPELLING") }))).toBe("SHEET-SPELLING");
  });

  it("falls back to the guard register only when nothing else filed", () => {
    // Last on purpose: the register's spelling is the one the fold exists to
    // forgive, so it is the least trustworthy label — but it beats printing a
    // string no book contains.
    expect(displayBarcode(view({ P: saw("F0LX4F2381040") }))).toBe("F0LX4F2381040");
  });

  it("falls back to the canonical when no source recorded a spelling", () => {
    // What every surface showed before this existed, so an empty view is not a
    // regression and never renders blank.
    expect(displayBarcode(view())).toBe("FUMY6B23070029");
  });

  it("never returns an empty string", () => {
    expect(displayBarcode(view({ O: { ...saw(), rawBarcodes: [] } }))).toBe("FUMY6B23070029");
  });

  it("does not change the canonical it belongs to", () => {
    // The invariant that keeps this safe: the label is cosmetic, the key is not.
    // Every spelling a source recorded folds to the same canonical by
    // construction — that is why they were grouped into one view at all.
    for (const raw of ["FUMYGB23070029", "AP8IS725090229", "XX0TP4LT22043643"]) {
      const v = view({ canonical: canonicalize(raw), O: saw(raw) });
      expect(canonicalize(displayBarcode(v))).toBe(v.canonical);
    }
  });
});
