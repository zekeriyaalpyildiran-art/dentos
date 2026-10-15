// GS1 parser vectors V1-V22 (spec p7_rules_ui §14.5). Synthetic codes only.

import { describe, expect, it } from "vitest";
import { gtinCheckDigitOk, normalizeGtin, parseGs1, validDate } from "../gs1";

const GS = "\u001d";
const G = "01095060001343521727123110LOT21ABC" + GS + "21SER17XYZ";
const FULL = { gtin: "09506000134352", expiry: "2027-12-31", lot: "LOT21ABC", serial: "SER17XYZ" };

describe("parseGs1", () => {
  it("V1: symbology prefixes and a leading GS", () => {
    for (const p of ["", "]d2", "]C1", "]Q3", GS]) {
      expect(parseGs1(p + G)).toEqual(FULL);
    }
  });

  it("V2: prefix is case-insensitive", () => {
    expect(parseGs1("]D2" + G)).toEqual(FULL);
  });

  it("V3: bracketed form, day 00 is the last day of the month", () => {
    const r = parseGs1("(01)09506000134352(17)270200(10)A");
    expect(r.expiry).toBe("2027-02-28");
    expect(r.lot).toBe("A");
    expect(r.gtin).toBe("09506000134352");
  });

  it("V4: leap years", () => {
    expect(parseGs1("(17)240200")).toEqual({ gtin: "", expiry: "2024-02-29", lot: "", serial: "" });
    expect(parseGs1("(17)250200").expiry).toBe("2025-02-28");
    expect(parseGs1("(17)240229").expiry).toBe("2024-02-29");
  });

  it("V5: 29 February of a common year fails", () => {
    expect(() => parseGs1("(17)230229")).toThrow("Barkoddaki son kullanma tarihi geçersiz.");
  });

  it("V6: month 13 fails", () => {
    expect(() => parseGs1("(01)08690000001001(17)301332")).toThrow("Barkoddaki son kullanma tarihi geçersiz.");
  });

  it("V7: raw form with a lot ending at GS", () => {
    expect(parseGs1("]d201086900000010011730020010LOT2117" + GS + "21SERIAL17")).toEqual({
      gtin: "08690000001001",
      expiry: "2030-02-28",
      lot: "LOT2117",
      serial: "SERIAL17",
    });
  });

  it("V8: duplicate AI fails closed", () => {
    expect(() => parseGs1("(01)09506000134352(01)09506000134352")).toThrow(
      "Barkoddaki lot veya ürün bilgisi geçersiz"
    );
  });

  it("V9: unsupported AI", () => {
    expect(() => parseGs1("(01)09506000134352(99)garbage")).toThrow("Bu barkod biçimi desteklenmiyor");
  });

  it("V10: duplicate raw AI 10", () => {
    expect(() => parseGs1(G + GS + "10duplicate")).toThrow("Barkoddaki lot veya ürün bilgisi geçersiz");
  });

  it("V11: a URL is not supported", () => {
    expect(() => parseGs1("https://example.test/01/09506000134352")).toThrow("desteklenmiyor");
  });

  it("V12: plain GTINs are padded to 14 digits", () => {
    expect(parseGs1("9506000134352")).toEqual({ gtin: "09506000134352", expiry: "", lot: "", serial: "" });
    expect(parseGs1("12345678").gtin).toBe("00000012345678");
    expect(parseGs1("  1234567890123  ").gtin).toBe("01234567890123");
  });

  it("V13: 9 and 11 digits are read as unsupported AI 12", () => {
    expect(() => parseGs1("123456789")).toThrow("desteklenmiyor");
    expect(() => parseGs1("12345678901")).toThrow("desteklenmiyor");
  });

  it("V14: a 20-character lot is accepted", () => {
    expect(parseGs1("(01)09506000134352(10)ABCDEFGHIJKLMNOPQRST").lot).toBe("ABCDEFGHIJKLMNOPQRST");
  });

  it("V15: a 21-character lot fails", () => {
    expect(() => parseGs1("(01)09506000134352(10)ABCDEFGHIJKLMNOPQRSTU")).toThrow(
      "Barkoddaki lot veya ürün bilgisi geçersiz"
    );
  });

  it("V16: AI 01 with 13 digits", () => {
    expect(() => parseGs1("010950600013435")).toThrow("Barkoddaki ürün kodu geçersiz.");
  });

  it("V17: AI 17 too short", () => {
    expect(() => parseGs1("0109506000134352172712")).toThrow("Barkoddaki son kullanma tarihi geçersiz.");
  });

  it("V18: trailing and leading separators", () => {
    expect(parseGs1("0109506000134352" + GS)).toEqual({ gtin: "09506000134352", expiry: "", lot: "", serial: "" });
    expect(parseGs1(GS + GS + "0109506000134352").gtin).toBe("09506000134352");
  });

  it("V19: bracketed form with a GS between fields", () => {
    expect(parseGs1("(01)09506000134352" + GS + "(10)ABC").lot).toBe("ABC");
  });

  it("V20: empty fields", () => {
    expect(() => parseGs1("(10)")).toThrow("desteklenmiyor");
    expect(() => parseGs1("0109506000134352" + "10" + GS + "21X")).toThrow(
      "Barkoddaki lot veya ürün bilgisi geçersiz"
    );
  });

  it("V21: input longer than 512 characters", () => {
    expect(() => parseGs1("x".repeat(513))).toThrow("Barkod verisi çok uzun");
  });

  it("V22: arbitrary text", () => {
    expect(() => parseGs1("ABC")).toThrow("desteklenmiyor");
  });
});

describe("helpers", () => {
  it("validDate round-trips real days only", () => {
    expect(validDate("2024-02-29")).toBe(true);
    expect(validDate("2099-02-30")).toBe(false);
    expect(validDate("2024-13-01")).toBe(false);
    expect(validDate("2024-1-01")).toBe(false);
  });

  it("normalizeGtin", () => {
    expect(normalizeGtin("9506000134352")).toBe("09506000134352");
    expect(normalizeGtin("123")).toBeNull();
    expect(normalizeGtin("12345678901")).toBeNull();
  });

  it("gtinCheckDigitOk", () => {
    expect(gtinCheckDigitOk("09506000134352")).toBe(true);
    expect(gtinCheckDigitOk("09506000134353")).toBe(false);
  });
});
