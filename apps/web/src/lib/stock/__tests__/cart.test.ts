// Bulk cart helpers: only contract keys reach stock_bulk_receive; row numbers come back from errors.

import { describe, expect, it } from "vitest";
import { bulkErrorRow, toBulkLine, type CartLine } from "../cart";

const line: CartLine = {
  key: "k1",
  stock_item_id: "i1",
  item_name: "Kurgu ürün",
  tracking_level: "B",
  usage_unit: "adet",
  purchase_unit: "kutu",
  units_per_purchase: 50,
  to_location_id: "l1",
  to_location_name: "Ana Depo",
  quantity: 2,
  quantity_unit: "purchase",
  lot_number: " L1 ",
  serial_number: "",
  expiry_date: "2027-01-31",
  supplier_id: "",
  document_no: "",
  reason: "",
};

describe("toBulkLine", () => {
  it("sends only contract keys and blanks as null", () => {
    expect(toBulkLine(line)).toEqual({
      stock_item_id: "i1",
      to_location_id: "l1",
      quantity: 2,
      quantity_unit: "purchase",
      units_per_purchase: 50,
      lot_number: "L1",
      serial_number: null,
      expiry_date: "2027-01-31",
      supplier_id: null,
      document_no: null,
      reason: null,
    });
  });

  it("sends the factor the line was entered with only when the purchase unit is used", () => {
    expect(toBulkLine(line).units_per_purchase).toBe(50);
    const usage = toBulkLine({ ...line, quantity_unit: "usage" });
    expect("units_per_purchase" in usage).toBe(false);
    // A cost per box also depends on the factor (batch cost, lot merge).
    expect(
      toBulkLine({ ...line, quantity_unit: "usage", unit_cost_cents: 5000, cost_unit: "purchase" }).units_per_purchase
    ).toBe(50);
    expect("units_per_purchase" in toBulkLine({ ...line, quantity_unit: "usage", unit_cost_cents: 100, cost_unit: "usage" })).toBe(
      false
    );
  });

  it("includes the cost only when present", () => {
    expect(toBulkLine({ ...line, unit_cost_cents: 1250, cost_unit: "purchase" })).toMatchObject({
      unit_cost_cents: 1250,
      cost_unit: "purchase",
    });
    expect("unit_cost_cents" in toBulkLine({ ...line, unit_cost_cents: null })).toBe(false);
  });
});

describe("bulkErrorRow", () => {
  it("reads DETAIL or the message prefix", () => {
    expect(bulkErrorRow("x", "3")).toBe(3);
    expect(bulkErrorRow("x", '{"row": 4}')).toBe(4);
    expect(bulkErrorRow("2. satır: Bu üründe son kullanma tarihini girin.", null)).toBe(2);
    expect(bulkErrorRow("Bir hata", null)).toBeNull();
  });
});
