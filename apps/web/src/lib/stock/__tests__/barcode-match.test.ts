// Barcode matching vectors V23-V37 and decoder filters V41-V43, V47 (spec p7_rules_ui §14.5).

import { describe, expect, it } from "vitest";
import {
  batchMatchesScan,
  hasScannedBatch,
  identifyStockBarcode,
  resolveNewProductGtin,
  resolveStockScan,
  type MatchItem,
} from "../barcode-match";
import { detectorResultTrusted, uniqueBarcodeTexts } from "../barcode-filter";

const GS = "\u001d";
const G = "01095060001343521727123110LOT21ABC" + GS + "21SER17XYZ";
const ITEMS: MatchItem[] = [{ id: "i7", gtin: "09506000134352" }];
const scanOf = (raw: string) => resolveStockScan(raw, ITEMS);

describe("resolveStockScan", () => {
  it("V23: every prefix resolves to the item with lot, serial and expiry", () => {
    for (const p of ["", "]d2", "]C1", "]Q3", GS]) {
      expect(resolveStockScan(p + G, ITEMS)).toMatchObject({
        itemId: "i7",
        lot: "LOT21ABC",
        serial: "SER17XYZ",
        expiry: "2027-12-31",
        gtin: "09506000134352",
      });
    }
  });

  it("V24: unknown barcode", () => {
    expect(() => resolveStockScan(G, [])).toThrow("Bu barkod ürün listesinde yok");
  });

  it("V25: two cards with the same GTIN", () => {
    expect(() => resolveStockScan(G, [...ITEMS, { id: "i8", gtin: "09506000134352" }])).toThrow(
      "birden fazla ürüne bağlı"
    );
  });

  it("V26: a code without a GTIN", () => {
    expect(() => resolveStockScan("(10)LOT21ABC", ITEMS)).toThrow("Bu kodda ürün barkodu bulunamadı");
  });

  it("V27: locked item mismatch (Phase 8 hook)", () => {
    expect(() => resolveStockScan(G, ITEMS, "i8")).toThrow("Okunan ürün seçilen siparişle eşleşmiyor.");
  });

  it("V28: plain EAN-13", () => {
    expect(resolveStockScan("9506000134352", ITEMS).itemId).toBe("i7");
  });

  it("V29: a stored 13-digit GTIN is padded before comparing", () => {
    expect(resolveStockScan(G, [{ id: "i7", gtin: "9506000134352" }]).itemId).toBe("i7");
  });
});

describe("resolveNewProductGtin", () => {
  it("V30: returns the 14-digit GTIN", () => {
    expect(resolveNewProductGtin("9506000134352", [])).toBe("09506000134352");
    expect(resolveNewProductGtin(G, [])).toBe("09506000134352");
  });

  it("V31: refuses a GTIN another card holds", () => {
    expect(() => resolveNewProductGtin(G, [{ ...ITEMS[0], name: "Kayıtlı ürün" }])).toThrow(/Kayıtlı ürün/);
  });

  it("V32: a code without a GTIN", () => {
    expect(() => resolveNewProductGtin("(10)LOT21ABC", [])).toThrow(/ürün barkodu/);
  });

  it("empty input", () => {
    expect(() => resolveNewProductGtin("   ", [])).toThrow("Barkod okunamadı");
  });
});

describe("identifyStockBarcode", () => {
  it("V33: new GTIN keeps the scanned lot and serial", () => {
    const r = identifyStockBarcode(G, []);
    expect(r.kind).toBe("new");
    expect(r.scan.lot).toBe("LOT21ABC");
    expect(r.scan.serial).toBe("SER17XYZ");
  });

  it("V34: known GTIN", () => {
    expect(identifyStockBarcode(G, ITEMS).kind).toBe("known");
  });

  it("empty or too long input", () => {
    expect(() => identifyStockBarcode("  ", ITEMS)).toThrow("Kod okunamadı");
    expect(() => identifyStockBarcode("1".repeat(513), ITEMS)).toThrow("Kod okunamadı");
  });
});

describe("batch matching", () => {
  const batch = { stockItemId: "i7", lotNumber: "LOT21ABC", serialNumber: "SER17XYZ", expiryDate: "2027-12-31" };

  it("V35: every scanned field must match", () => {
    const scan = scanOf(G);
    expect(batchMatchesScan(batch, scan)).toBe(true);
    expect(batchMatchesScan({ ...batch, stockItemId: "i8" }, scan)).toBe(false);
    expect(batchMatchesScan({ ...batch, lotNumber: "OTHER" }, scan)).toBe(false);
    expect(batchMatchesScan({ ...batch, serialNumber: "OTHER" }, scan)).toBe(false);
    expect(batchMatchesScan({ ...batch, expiryDate: "2027-12-30" }, scan)).toBe(false);
  });

  it("V35b: a scan without a resolved card matches no lot (fails closed)", () => {
    const batch = { stockItemId: "i7", lotNumber: "LOT21ABC", serialNumber: "SER17XYZ", expiryDate: "2027-12-31" };
    expect(batchMatchesScan(batch, { lot: "LOT21ABC", serial: "SER17XYZ", expiry: "2027-12-31" })).toBe(false);
    expect(batchMatchesScan(batch, { lot: "LOT21ABC", itemId: "" })).toBe(false);
  });

  it("V36: an empty scan field matches anything", () => {
    expect(
      batchMatchesScan({ stockItemId: "i7", lotNumber: "X", serialNumber: null, expiryDate: null }, scanOf("9506000134352"))
    ).toBe(true);
  });

  it("V37: hasScannedBatch", () => {
    expect(hasScannedBatch(scanOf("9506000134352"))).toBe(false);
    expect(hasScannedBatch(scanOf(G))).toBe(true);
    expect(hasScannedBatch(null)).toBe(false);
  });
});

describe("decoder filters", () => {
  const r = { isValid: true, text: G, sequenceSize: -1, readerInit: false };

  it("V41: duplicates collapse", () => {
    expect(uniqueBarcodeTexts([r, r])).toHaveLength(1);
  });

  it("V42: different texts stay", () => {
    expect(uniqueBarcodeTexts([r, { ...r, text: "9506000134352" }])).toHaveLength(2);
  });

  it("V43: partial, programming, invalid, oversized and empty symbols are dropped", () => {
    expect(
      uniqueBarcodeTexts([
        { ...r, sequenceSize: 3 },
        { ...r, readerInit: true },
        { ...r, isValid: false },
        { ...r, text: "x".repeat(513) },
        { ...r, text: "" },
      ])
    ).toHaveLength(0);
  });

  it("V47: detector results without separators are not trusted when they carry a lot or serial", () => {
    expect(detectorResultTrusted("9506000134352")).toBe(true);
    expect(detectorResultTrusted(G)).toBe(true);
    expect(detectorResultTrusted("(01)09506000134352(10)A(21)B")).toBe(true);
    expect(detectorResultTrusted("0109506000134352172712311" + "0LOT" + "21SER")).toBe(false);
  });

  it("an unparseable detector result is not trusted", () => {
    expect(detectorResultTrusted("ABC")).toBe(false);
  });
});
