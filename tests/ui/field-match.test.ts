import { describe, expect, it } from "vitest";
import { fieldMatch, type MatchRow, type MatchSource } from "../../lib/ui/field-match";

const by = (p: Partial<Record<MatchSource, MatchRow[]>>) =>
  ({ PHYSICAL: [], SHEET: [], DT: [], ODOO: [], ...p }) as Record<MatchSource, MatchRow[]>;

describe("does a field agree across the four systems", () => {
  it("all four hold it and agree, despite spelling → matched", () => {
    const r = fieldMatch(by({
      PHYSICAL: [{ customer: "MEENAL ATRI" }], SHEET: [{ customer: "Meenal Atri" }],
      DT: [{ customer: "meenal atri " }], ODOO: [{ customer: "Meenal  Atri" }],
    }), "customer");
    expect(r.state).toBe("all");
  });

  it("SO with and without hyphens is the same SO", () => {
    expect(fieldMatch(by({ DT: [{ so_number: "ON-RET-DEL-13965" }], ODOO: [{ so_number: "ONRETDEL13965" }] }), "so_number").state).toBe("partial");
  });

  it("barcodes compare on the fold", () => {
    const r = fieldMatch(by({ PHYSICAL: [{ barcode: "AP8IS726090175" }], SHEET: [{ barcode: "AP815726090175" }],
      DT: [{ barcode: "AP8IS726090175" }], ODOO: [{ barcode: "AP8IS726090175" }] }), "barcode");
    expect(r.state).toBe("all");
  });

  it("some sources silent, the rest agree → partial, not matched", () => {
    expect(fieldMatch(by({ PHYSICAL: [{ product: "WM" }], DT: [{ product: "wm" }] }), "product").state).toBe("partial");
  });

  it("two values → differs, with each system's value kept for the tooltip", () => {
    const r = fieldMatch(by({ DT: [{ so_number: "ON-1" }], ODOO: [{ so_number: "ON-2" }] }), "so_number");
    expect(r.state).toBe("differ");
    expect(r.holders.map((h) => h.value)).toEqual(["ON-1", "ON-2"]);
  });

  it("ticket leaves Odoo out — its 'ticket' is a transfer reference", () => {
    const r = fieldMatch(by({
      PHYSICAL: [{ ticket_id: "1216201" }], SHEET: [{ ticket_id: "1216201" }], DT: [{ ticket_id: "1216201" }],
      ODOO: [{ ticket_id: "GUR/IN/20188" }],
    }), "ticket_id");
    expect(r.state).toBe("all");
    expect(r.compared).toEqual(["PHYSICAL", "SHEET", "DT"]);
  });

  it("nobody holds it → none", () => {
    expect(fieldMatch(by({}), "customer").state).toBe("none");
  });
});
