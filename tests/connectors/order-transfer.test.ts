import { describe, expect, it } from "vitest";
import { isOrderTransfer } from "../../lib/connectors/odoo";
import { REASONS, REASON_HINT } from "../../lib/ui/closure-reasons";

// An order transfer reassigns a unit between orders inside Odoo. No truck
// moves, so the gate register, the ops sheet and the delivery app correctly
// have nothing — and reconciled normally it becomes an "Odoo-only" chase item
// for a unit that never went anywhere.
//
// The field is sale_order.reference_no (the UI's "Reference#"), NOT
// sml.reference, which is the picking ref BAN/OUT/58612.

describe("order transfers are recognised by Reference#", () => {
  it("matches the real value from SO ON-RET-BAN-85606", () => {
    expect(isOrderTransfer("OT-20260726-695913")).toBe(true);
  });

  it("matches regardless of case or padding", () => {
    expect(isOrderTransfer("ot-20260726-695913")).toBe(true);
    expect(isOrderTransfer("  OT-20260101-1  ")).toBe(true);
  });

  it("does not match the other reference_no values the field actually holds", () => {
    // Measured on live Odoo: these are the real inhabitants of this column.
    for (const other of ["NA", "N/A", "NO BROKER", "#1483943550", "2779584400", "", "824693478"]) {
      expect(isOrderTransfer(other), other).toBe(false);
    }
  });

  it("does not match a picking reference, which is a different column", () => {
    // sml.reference never starts OT-; conflating the two would filter nothing
    // or, worse, filter real movements.
    for (const ref of ["BAN/OUT/58612", "BAN/PICK/58951", "GUR/INT-RET/01903", "BAN/BUY-BACK/00751"]) {
      expect(isOrderTransfer(ref), ref).toBe(false);
    }
  });

  it("does not match something merely containing OT", () => {
    expect(isOrderTransfer("LOT-123")).toBe(false);
    expect(isOrderTransfer("PO-BAN-631")).toBe(false);
    expect(isOrderTransfer("ROTATION-9")).toBe(false);
  });

  it("treats null and undefined as not a transfer", () => {
    expect(isOrderTransfer(null)).toBe(false);
    expect(isOrderTransfer(undefined)).toBe(false);
  });
});

describe("Order Transfer is offered when closing an item", () => {
  it("appears in the dropdown with a hint explaining it", () => {
    // Items raised before the filter shipped still need closing by hand.
    expect(REASONS).toContain("Order Transfer");
    expect(REASON_HINT["Order Transfer"]).toBeTruthy();
  });

  it("sits with the other 'this was not a real gap' reasons, not at the end", () => {
    expect(REASONS.indexOf("Order Transfer")).toBeLessThan(REASONS.indexOf("Other"));
  });
});
