// Units and expiry vectors V38-V40, V48-V49 (spec p7_rules_ui §14.5).

import { describe, expect, it } from "vitest";
import {
  AMBIGUOUS_QTY_MESSAGE,
  chooseUnit,
  conversionLine,
  formatQty,
  isAmbiguousThousands,
  parseQty,
  qtyInputProblem,
  quantityInStockUnits,
} from "../units";
import { addDays, daysLeft, expiryLabel, expiryTone } from "../expiry";

describe("quantityInStockUnits", () => {
  it("V38: conversion and rounding to 4 decimals", () => {
    expect(quantityInStockUnits(3, "purchase", 100)).toBe(300);
    expect(quantityInStockUnits(0.5, "purchase", 100)).toBe(50);
    expect(quantityInStockUnits(2, "purchase", 4.5)).toBe(9);
    expect(quantityInStockUnits(0.12345, "usage", 1)).toBe(0.1235);
  });

  it("V39: invalid input gives NaN", () => {
    expect(quantityInStockUnits(1, "made-up", 1)).toBeNaN();
    expect(quantityInStockUnits(0, "usage", 1)).toBeNaN();
    expect(quantityInStockUnits(1, "purchase", 0)).toBeNaN();
    expect(quantityInStockUnits(NaN, "usage", 1)).toBeNaN();
  });
});

describe("chooseUnit", () => {
  it("V40: purchase unit only for a receipt without serial", () => {
    expect(chooseUnit({ units_per_purchase: 10 }, "receive", "")).toBe("purchase");
    expect(chooseUnit({ units_per_purchase: 10 }, "receive", "S1")).toBe("usage");
    expect(chooseUnit({ units_per_purchase: 10 }, "issue", "")).toBe("usage");
    expect(chooseUnit({ units_per_purchase: 1 }, "receive", "")).toBe("usage");
  });
});

describe("display and input", () => {
  it("formatQty shows up to 4 decimals in Turkish format", () => {
    expect(formatQty(1234.5)).toBe("1.234,5");
    expect(formatQty(0.1235)).toBe("0,1235");
    expect(formatQty(null)).toBe("—");
  });

  it("parseQty accepts comma or dot decimals, at most 4", () => {
    expect(parseQty("2,5")).toBe(2.5);
    expect(parseQty("2.5")).toBe(2.5);
    expect(parseQty("1.000,25")).toBe(1000.25);
    expect(parseQty("0")).toBe(0);
    expect(parseQty("1,23456")).toBeNaN();
    // Turkish thousands grouping without a comma is ambiguous: refused, never read as 1 or 12.5.
    expect(parseQty("1.000")).toBeNaN();
    expect(parseQty("12.500")).toBeNaN();
    expect(parseQty("1.000.000")).toBeNaN();
    expect(isAmbiguousThousands("1.000")).toBe(true);
    expect(isAmbiguousThousands("1.5")).toBe(false);
    expect(isAmbiguousThousands("1.000,5")).toBe(false);
    expect(parseQty("1.5")).toBe(1.5);
    expect(parseQty("1.0005")).toBe(1.0005);
    expect(qtyInputProblem("1.000")).toBe(AMBIGUOUS_QTY_MESSAGE);
    expect(qtyInputProblem("2,5")).toBeNull();
    expect(qtyInputProblem("abc")).toBe("Geçerli bir miktar girin.");
    expect(parseQty("-1")).toBeNaN();
    expect(parseQty("")).toBeNaN();
  });

  it("conversionLine", () => {
    expect(conversionLine(2, "kutu", "adet", 50)).toBe("2 kutu = 100 adet");
  });
});

describe("expiry", () => {
  it("V48: daysLeft", () => {
    expect(daysLeft("2026-10-15", "2026-10-15")).toBe(0);
    expect(daysLeft("2026-10-14", "2026-10-15")).toBe(-1);
    expect(daysLeft("2027-01-13", "2026-10-15")).toBe(90);
  });

  it("V49: expiryTone", () => {
    expect(expiryTone(-1)).toBe("red");
    expect(expiryTone(30)).toBe("red");
    expect(expiryTone(31)).toBe("amber");
    expect(expiryTone(90)).toBe("amber");
    expect(expiryTone(91)).toBeNull();
  });

  it("labels", () => {
    expect(expiryLabel(-3)).toBe("Süresi geçmiş — kullanmayın");
    expect(expiryLabel(0)).toBe("Bugün son gün");
    expect(expiryLabel(12)).toBe("12 gün kaldı");
  });

  it("addDays", () => {
    expect(addDays("2026-10-15", 90)).toBe("2027-01-13");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
  });
});
