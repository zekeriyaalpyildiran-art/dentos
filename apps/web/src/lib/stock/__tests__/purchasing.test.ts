// Purchasing helpers (spec p8_purchasing §12.1, §14).

import { describe, expect, it } from "vitest";
import {
  PAYABLE_STATE_LABELS,
  PO_STATUSES,
  PO_STATUS_LABELS,
  PO_STATUS_STYLES,
  ROOM_REQUEST_STATUSES,
  ROOM_REQUEST_STATUS_LABELS,
  ROOM_REQUEST_STATUS_STYLES,
  buildPoPayload,
  isOverdue,
  lineTotalCents,
  packsOf,
  poLineRemaining,
  poStatusLabel,
  pricePerUsage,
  qtyLabel,
  qtyToInput,
  rowErrorIndex,
  type PoForm,
  type PoFormLine,
} from "../purchasing";

const TODAY = "2026-10-15";

function line(over: Partial<PoFormLine> = {}): PoFormLine {
  return {
    stock_item_id: "item-1",
    item_name: "Nitril eldiven",
    tracking_level: "C",
    usage_unit: "adet",
    purchase_unit: "kutu",
    units_per_purchase: 100,
    qty_text: "9",
    quantity_unit: "purchase",
    price_text: "",
    price_unit: "usage",
    note: "",
    ...over,
  };
}

function form(over: Partial<PoForm> = {}): PoForm {
  return { supplier_id: "sup-1", expected_date: "", note: "", lines: [line()], ...over };
}

describe("packs and labels", () => {
  it("packsOf", () => {
    expect(packsOf(900, 100)).toEqual({ packs: 9, whole: true });
    expect(packsOf(905, 100)).toEqual({ packs: 9.05, whole: false });
    expect(packsOf(17, 1)).toEqual({ packs: 17, whole: true });
  });

  it("qtyLabel", () => {
    expect(qtyLabel(900, "adet", "kutu", 100)).toBe("9 kutu (900 adet)");
    expect(qtyLabel(905, "adet", "kutu", 100)).toBe("905 adet");
    expect(qtyLabel(17, "adet", "adet", 1)).toBe("17 adet");
    expect(qtyLabel(0, "adet", "kutu", 100)).toBe("0 adet");
  });

  it("qtyToInput writes comma decimals without grouping", () => {
    expect(qtyToInput(1000)).toBe("1000");
    expect(qtyToInput(2.5)).toBe("2,5");
    expect(qtyToInput(null)).toBe("");
  });
});

describe("prices", () => {
  it("pricePerUsage", () => {
    expect(pricePerUsage(5000, "purchase", 10)).toBe(500);
    expect(pricePerUsage(1000, "purchase", 3)).toBe(333);
    expect(pricePerUsage(1000, "usage", 3)).toBe(1000);
  });

  it("lineTotalCents rounds half away from zero", () => {
    expect(lineTotalCents(900, 50)).toBe(45000);
    expect(lineTotalCents(2.5, 333)).toBe(833);
    expect(lineTotalCents(0.0001, 100_000_000_000)).toBe(10_000_000);
    expect(lineTotalCents(1_000_000, 100_000_000_000)).toBe(100_000_000_000_000_000);
  });
});

describe("order state helpers", () => {
  it("poLineRemaining", () => {
    const l = { qty_ordered: 900, qty_received: 400 };
    expect(poLineRemaining(l, "ordered")).toBe(500);
    expect(poLineRemaining(l, "partially_received")).toBe(500);
    expect(poLineRemaining(l, "pending")).toBe(500);
    expect(poLineRemaining(l, "received")).toBe(0);
    expect(poLineRemaining(l, "cancelled")).toBe(0);
  });

  it("isOverdue", () => {
    expect(isOverdue("2026-10-14", TODAY, "ordered")).toBe(true);
    expect(isOverdue("2026-10-14", TODAY, "pending")).toBe(false);
    expect(isOverdue("2026-10-15", TODAY, "ordered")).toBe(false);
    expect(isOverdue(null, TODAY, "ordered")).toBe(false);
  });

  it("label maps cover every status", () => {
    for (const s of PO_STATUSES) {
      expect(PO_STATUS_LABELS[s]).toBeTruthy();
      expect(PO_STATUS_STYLES[s]).toBeTruthy();
    }
    for (const s of ROOM_REQUEST_STATUSES) {
      expect(ROOM_REQUEST_STATUS_LABELS[s]).toBeTruthy();
      expect(ROOM_REQUEST_STATUS_STYLES[s]).toBeTruthy();
    }
    expect(PO_STATUSES).toHaveLength(6);
    expect(ROOM_REQUEST_STATUSES).toHaveLength(5);
    expect(PAYABLE_STATE_LABELS.none).toBe("");
    expect(poStatusLabel("received", true)).toBe("Eksik kapatıldı");
    expect(poStatusLabel("received", false)).toBe("Teslim alındı");
  });

  it("rowErrorIndex reads '<n>. satır:' with DETAIL n", () => {
    expect(rowErrorIndex({ message: "2. satır: Aynı ürün", detail: "2" })).toBe(1);
    expect(rowErrorIndex({ message: "2. satır: Aynı ürün", detail: null })).toBe(1);
    expect(rowErrorIndex({ message: "Sipariş bulunamadı.", detail: null })).toBeNull();
  });
});

describe("buildPoPayload", () => {
  it("create: drops empty notes and sends the factor only with the purchase unit", () => {
    const r = buildPoPayload(
      form({ lines: [line(), line({ stock_item_id: "item-2", quantity_unit: "usage", qty_text: "17", note: "  " })] }),
      { canViewCosts: false, today: TODAY }
    );
    expect(r).toEqual({
      ok: true,
      payload: {
        supplier_id: "sup-1",
        lines: [
          { stock_item_id: "item-1", quantity: 9, quantity_unit: "purchase", units_per_purchase: 100 },
          { stock_item_id: "item-2", quantity: 17 },
        ],
      },
    });
  });

  it("never sends price keys without cost view", () => {
    const r = buildPoPayload(form({ lines: [line({ price_text: "5,00", original_price_cents: 500 })] }), {
      canViewCosts: false,
      today: TODAY,
    });
    expect(r.ok && r.payload.lines?.[0]).not.toHaveProperty("unit_price_cents");
    expect(r.ok && r.payload.lines?.[0]).not.toHaveProperty("price_unit");
  });

  it("sends prices for viewers, per pack with the factor", () => {
    const r = buildPoPayload(
      form({ lines: [line({ quantity_unit: "usage", qty_text: "90", price_text: "50", price_unit: "purchase" })] }),
      { canViewCosts: true, today: TODAY }
    );
    expect(r.ok && r.payload.lines?.[0]).toEqual({
      stock_item_id: "item-1",
      quantity: 90,
      unit_price_cents: 5000,
      price_unit: "purchase",
      units_per_purchase: 100,
    });
  });

  it("sends null only when a viewer emptied a previously set price", () => {
    const cleared = buildPoPayload(form({ lines: [line({ original_price_cents: 50 })] }), {
      canViewCosts: true,
      today: TODAY,
    });
    expect(cleared.ok && cleared.payload.lines?.[0].unit_price_cents).toBeNull();
    const unpriced = buildPoPayload(form({ lines: [line({ original_price_cents: null })] }), {
      canViewCosts: true,
      today: TODAY,
    });
    expect(unpriced.ok && unpriced.payload.lines?.[0]).not.toHaveProperty("unit_price_cents");
  });

  it("validates like the server", () => {
    expect(buildPoPayload(form({ supplier_id: "" }), { canViewCosts: false, today: TODAY })).toMatchObject({ ok: false });
    expect(buildPoPayload(form({ lines: [] }), { canViewCosts: false, today: TODAY })).toMatchObject({
      ok: false,
      error: "Siparişe 1–20 ürün ekleyin.",
    });
    const many = Array.from({ length: 21 }, (_, i) => line({ stock_item_id: `i${i}` }));
    expect(buildPoPayload(form({ lines: many }), { canViewCosts: false, today: TODAY })).toMatchObject({ ok: false, line: null });
    expect(buildPoPayload(form({ lines: [line(), line()] }), { canViewCosts: false, today: TODAY })).toMatchObject({
      ok: false,
      line: 1,
    });
    expect(
      buildPoPayload(form({ lines: [line({ tracking_level: "A", quantity_unit: "usage", qty_text: "1,5" })] }), {
        canViewCosts: false,
        today: TODAY,
      })
    ).toMatchObject({ ok: false, error: "1. satır: Bu üründe tam adet girin.", line: 0 });
    expect(buildPoPayload(form({ expected_date: "2026-10-14" }), { canViewCosts: false, today: TODAY })).toMatchObject({
      ok: false,
      error: "Teslim tarihini kontrol edin.",
    });
    expect(buildPoPayload(form({ lines: [line({ qty_text: "0" })] }), { canViewCosts: false, today: TODAY })).toMatchObject({
      ok: false,
      line: 0,
    });
  });

  it("edit: sends only what changed; a note edit leaves lines out", () => {
    const original = form({ note: "Eski" });
    const noteOnly = buildPoPayload({ ...original, note: "Yeni" }, { canViewCosts: false, today: TODAY, original });
    expect(noteOnly).toEqual({ ok: true, payload: { note: "Yeni" } });
    const qty = buildPoPayload({ ...original, lines: [line({ qty_text: "10" })] }, { canViewCosts: false, today: TODAY, original });
    expect(qty.ok && Object.keys(qty.payload)).toEqual(["lines"]);
    expect(buildPoPayload(original, { canViewCosts: false, today: TODAY, original })).toMatchObject({ ok: false });
  });
});
