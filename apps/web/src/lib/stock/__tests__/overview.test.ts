// Stock overview helpers: grouping, value per card (stock_dashboard rules), attention list and period summaries.

import { describe, expect, it } from "vitest";
import {
  OTHER_GROUP,
  attentionRows,
  buildStockRows,
  countDiffRows,
  groupMovements,
  groupTotals,
  hasOutflow,
  inStock,
  monthRanges,
  periodRange,
  priceChanges,
  stockGroup,
  stockSummary,
  type OverviewItem,
} from "../overview";
import type { ConsumptionRow } from "../rpc";

const TODAY = "2026-10-31";

function item(id: string, name: string, extra: Partial<OverviewItem> = {}): OverviewItem {
  return {
    id,
    item_code: `K-${id}`,
    item_name: name,
    category: "Genel",
    usage_unit: "adet",
    min_qty: 0,
    max_qty: 0,
    is_active: true,
    needs_review: false,
    ...extra,
  };
}

function consumption(id: string, name: string, extra: Partial<ConsumptionRow> = {}): ConsumptionRow {
  return {
    stock_item_id: id,
    item_code: `K-${id}`,
    item_name: name,
    category: "Genel",
    tracking_level: "B",
    usage_unit: "adet",
    purchase_unit: "Kutu",
    units_per_purchase: 1,
    opening_qty: 0,
    received_qty: 0,
    received_po_qty: 0,
    used_qty: 0,
    returned_qty: 0,
    net_used_qty: 0,
    waste_qty: 0,
    adjust_in_qty: 0,
    adjust_out_qty: 0,
    adjust_net_qty: 0,
    room_delivery_qty: 0,
    ...extra,
  };
}

describe("stockGroup", () => {
  it("groups by product name, first rule wins", () => {
    expect(stockGroup("NEODENT İMP 3.75X10", "Genel")).toBe("İmplant ve parçaları");
    expect(stockGroup("Implant örtü seti", "Cerrahi")).toBe("Cerrahi sarf");
    expect(stockGroup("Opalescence Boost", null)).toBe("Beyazlatma");
    expect(stockGroup("Paper Points 25", "Endo")).toBe("Endodonti");
    expect(stockGroup("Nitril eldiven M", "Genel")).toBe("Eldiven ve hijyen");
  });

  it("folds dotless ı so capitalised names still match", () => {
    expect(stockGroup("Saddle Metal Matrıces", "Genel")).toBe("Restoratif");
    expect(stockGroup("INJECTION MOULDING KIT", "Genel")).toBe("Protez ve ölçü");
    expect(stockGroup("Hasta önlüğü", "Genel")).toBe("Eldiven ve hijyen");
  });

  it("falls back to Diğer", () => {
    expect(stockGroup("Bilinmeyen ürün", "Genel")).toBe(OTHER_GROUP);
    expect(stockGroup(null, null)).toBe(OTHER_GROUP);
  });
});

describe("buildStockRows", () => {
  const items = [
    item("a", "Neodent 3.5x10", { min_qty: 2, max_qty: 10 }),
    item("b", "Kompozit A2", { min_qty: 1, max_qty: 5 }),
    item("c", "Taslak ürün", { min_qty: 5, max_qty: 10, needs_review: true }),
    item("d", "Boş kart"),
    item("f", "Bitmiş bond", { min_qty: 1, max_qty: 4 }),
  ];
  const batches = [
    { id: "a1", stock_item_id: "a", expiry_date: "2030-01-01", received_at: "2026-10-15T09:00:00Z" },
    { id: "a2", stock_item_id: "a", expiry_date: "2026-10-01", received_at: "2026-10-15T09:00:00Z" },
    { id: "b1", stock_item_id: "b", expiry_date: "2026-12-15", received_at: "2026-10-15T09:00:00Z" },
    { id: "b2", stock_item_id: "b", expiry_date: null, received_at: "2026-10-20T09:00:00Z" },
    { id: "c1", stock_item_id: "c", expiry_date: null, received_at: "2026-10-15T09:00:00Z" },
  ];
  const balances = [
    { stock_item_id: "a", batch_id: "a1", quantity: "2" },
    { stock_item_id: "a", batch_id: "a2", quantity: 1 },
    { stock_item_id: "b", batch_id: "b1", quantity: 3 },
    { stock_item_id: "b", batch_id: "b2", quantity: 2 },
    { stock_item_id: "c", batch_id: "c1", quantity: 1 },
    { stock_item_id: "d", batch_id: "x", quantity: 0 },
  ];
  const costs = [
    { batch_id: "a1", unit_cost_cents: 390000 },
    { batch_id: "a2", unit_cost_cents: "390000" },
    { batch_id: "b1", unit_cost_cents: 50000 },
  ];
  const rows = buildStockRows(items, balances, batches, costs, TODAY);

  it("values every balance at its lot cost, expired stock included, unpriced lots apart", () => {
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c", "f"]);
    expect(rows.filter(inStock).map((r) => r.id)).toEqual(["a", "b", "c"]);
    const [a, b, c] = rows;
    expect(a).toMatchObject({
      qty: 3,
      usableQty: 2,
      expiredQty: 1,
      valueCents: 1170000,
      unpricedQty: 0,
      nextExpiry: "2026-10-01",
      nextExpiryQty: 1,
    });
    expect(a.daysToExpiry).toBe(-30);
    expect(b).toMatchObject({ qty: 5, usableQty: 5, valueCents: 150000, unpricedQty: 2, nextExpiry: "2026-12-15" });
    expect(c).toMatchObject({ valueCents: 0, unpricedQty: 1, nextExpiry: null, daysToExpiry: null });
  });

  it("uses the database critical predicate (usable <= min, max > 0, ready cards only), empty cards included", () => {
    expect(rows.find((r) => r.id === "a")?.critical).toBe(true);
    expect(rows.find((r) => r.id === "b")?.critical).toBe(false);
    expect(rows.find((r) => r.id === "c")?.critical).toBe(false);
    expect(rows.find((r) => r.id === "f")).toMatchObject({ qty: 0, usableQty: 0, valueCents: 0, critical: true });
    expect(rows.find((r) => r.id === "d")).toBeUndefined();
  });

  it("sums groups and the summary", () => {
    expect(groupTotals(rows)).toEqual([
      { group: "İmplant ve parçaları", valueCents: 1170000, items: 1, unpricedItems: 0 },
      { group: "Restoratif", valueCents: 150000, items: 1, unpricedItems: 1 },
      { group: OTHER_GROUP, valueCents: 0, items: 1, unpricedItems: 1 },
    ]);
    expect(stockSummary(rows)).toEqual({
      valueCents: 1320000,
      implantValueCents: 1170000,
      items: 3,
      unpricedItems: 2,
      criticalItems: 2,
      expiringItems: 2,
    });
  });

  it("lists attention rows by nearest expiry, then empty cards, then low stock", () => {
    const low = buildStockRows(
      [item("e", "Bond", { min_qty: 3, max_qty: 6 })],
      [{ stock_item_id: "e", batch_id: "e1", quantity: 1 }],
      [],
      [],
      TODAY
    );
    const list = attentionRows([...low, ...rows]);
    expect(list.map((r) => [r.id, r.expiryState, r.levelState])).toEqual([
      ["a", "expired", "critical"],
      ["b", "expiry90", null],
      ["f", null, "out"],
      ["e", null, "critical"],
    ]);
  });
});

describe("period summaries", () => {
  // Owner shape: every cost key present, an unpriced movement adds 0 and counts in uncosted_rows.
  const priced = { received_cost_cents: 0, net_used_cost_cents: 0, waste_cost_cents: 0, adjust_net_cost_cents: 0, uncosted_rows: 0 };
  const report = [
    consumption("a", "Neodent 3.5x10", { ...priced, net_used_cost_cents: 780000, adjust_net_qty: -1, adjust_net_cost_cents: -390000 }),
    consumption("b", "Kompozit A2", { ...priced, net_used_cost_cents: 10000, adjust_net_qty: 2, adjust_net_cost_cents: 100000 }),
    consumption("c", "Meron", { ...priced, adjust_net_qty: -4, uncosted_rows: 1 }),
    consumption("d", "Bond", { ...priced, received_cost_cents: 50000, waste_qty: 1, waste_cost_cents: 2500 }),
    consumption("e", "Gutta", { ...priced, adjust_net_qty: -2, adjust_net_cost_cents: -500, uncosted_rows: 1 }),
  ];

  it("splits count differences into loss and gain per group, waste apart", () => {
    expect(groupMovements(report)).toEqual([
      { group: "İmplant ve parçaları", usedCents: 780000, wasteCents: 0, countLossCents: 390000, countGainCents: 0 },
      { group: "Restoratif", usedCents: 10000, wasteCents: 2500, countLossCents: 0, countGainCents: 100000 },
      { group: "Endodonti", usedCents: 0, wasteCents: 0, countLossCents: 500, countGainCents: 0 },
    ]);
  });

  it("lists count differences, biggest loss first; all-unpriced as null, partly unpriced flagged", () => {
    expect(countDiffRows(report).map((r) => [r.id, r.qty, r.costCents, r.partlyUnpriced])).toEqual([
      ["a", -1, -390000, false],
      ["e", -2, -500, true],
      ["c", -4, null, false],
      ["b", 2, 100000, false],
    ]);
  });

  it("tells an unpriced outflow from no outflow", () => {
    expect(hasOutflow([consumption("c", "Meron", { ...priced, adjust_net_qty: -4, uncosted_rows: 1 })])).toBe(true);
    expect(hasOutflow([consumption("d", "Bond", { ...priced, received_qty: 3, received_cost_cents: 50000 })])).toBe(false);
  });
});

describe("priceChanges", () => {
  it("compares the first and the latest priced lot", () => {
    const items = [item("a", "Nitril eldiven"), item("b", "Bond"), item("c", "Kompozit")];
    const batches = [
      { id: "a2", stock_item_id: "a", expiry_date: null, received_at: "2026-11-02T08:00:00Z" },
      { id: "a1", stock_item_id: "a", expiry_date: null, received_at: "2026-10-15T08:00:00Z" },
      { id: "b1", stock_item_id: "b", expiry_date: null, received_at: "2026-10-15T08:00:00Z" },
      { id: "b2", stock_item_id: "b", expiry_date: null, received_at: "2026-11-02T08:00:00Z" },
      { id: "c1", stock_item_id: "c", expiry_date: null, received_at: "2026-10-15T08:00:00Z" },
      { id: "c2", stock_item_id: "c", expiry_date: null, received_at: "2026-11-02T08:00:00Z" },
    ];
    const costs = [
      { batch_id: "a1", unit_cost_cents: 23000 },
      { batch_id: "a2", unit_cost_cents: 27600 },
      { batch_id: "b1", unit_cost_cents: 5000 },
      { batch_id: "b2", unit_cost_cents: 5000 },
      { batch_id: "c1", unit_cost_cents: 10000 },
    ];
    expect(priceChanges(items, batches, costs)).toEqual([
      {
        id: "a",
        code: "K-a",
        name: "Nitril eldiven",
        unit: "adet",
        firstDay: "2026-10-15",
        firstCents: 23000,
        lastDay: "2026-11-02",
        lastCents: 27600,
        change: 0.2,
      },
    ]);
  });
});

describe("periods", () => {
  it("builds the period presets", () => {
    expect(periodRange("30d", TODAY)).toEqual({ from: "2026-10-02", to: TODAY });
    expect(periodRange("90d", TODAY)).toEqual({ from: "2026-08-03", to: TODAY });
    expect(periodRange("month", TODAY)).toEqual({ from: "2026-10-01", to: TODAY });
    expect(periodRange("prev_month", TODAY)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(periodRange("prev_month", "2027-01-05")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });

  it("lists the last months oldest first, the current one ending today", () => {
    expect(monthRanges("2027-02-10", 3)).toEqual([
      { month: "2026-12", from: "2026-12-01", to: "2026-12-31" },
      { month: "2027-01", from: "2027-01-01", to: "2027-01-31" },
      { month: "2027-02", from: "2027-02-01", to: "2027-02-10" },
    ]);
  });
});
