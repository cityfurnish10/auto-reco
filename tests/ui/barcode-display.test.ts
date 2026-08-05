import { describe, expect, it } from "vitest";
import { shownBarcode } from "../../lib/ui/barcode-display";

describe("shownBarcode", () => {
  it("prefers the spelling a typed source recorded", () => {
    expect(shownBarcode({ barcode: "AP815725090229", barcode_display: "AP8IS725090229" }))
      .toBe("AP8IS725090229");
  });

  it("falls back to the canonical on a row written before migration 0020", () => {
    // Not a regression: the canonical is what every surface showed before this
    // existed, so an old row simply keeps looking the way it always did.
    expect(shownBarcode({ barcode: "FUMY6B23070029" })).toBe("FUMY6B23070029");
    expect(shownBarcode({ barcode: "FUMY6B23070029", barcode_display: null })).toBe("FUMY6B23070029");
  });

  it("treats a blank or whitespace display value as absent", () => {
    // A trimmed-to-nothing column must never render as an empty cell where a
    // barcode belongs.
    expect(shownBarcode({ barcode: "CF1", barcode_display: "" })).toBe("CF1");
    expect(shownBarcode({ barcode: "CF1", barcode_display: "   " })).toBe("CF1");
  });

  it("never throws on a missing row", () => {
    expect(shownBarcode(null)).toBe("");
    expect(shownBarcode(undefined)).toBe("");
  });
});
