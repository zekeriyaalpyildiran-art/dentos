// Decimal and TL vectors N1-N5 (spec p9_clinical §8.3).

import { describe, expect, it } from "vitest";
import { centsToTlInput, formatDecimalTr, formatTl, parseDecimalTr, parseTlToCents } from "../numbers";

describe("parseDecimalTr", () => {
  it("N1: comma or dot decimals", () => {
    expect(parseDecimalTr("4,0", 2)).toBe(4);
    expect(parseDecimalTr("4.0", 2)).toBe(4);
    expect(parseDecimalTr("3,75", 2)).toBe(3.75);
  });

  it("N2: too many decimals, two separators, letters and grouping are refused", () => {
    expect(parseDecimalTr("4,005", 2)).toBeNull();
    expect(parseDecimalTr("4,0,1", 2)).toBeNull();
    expect(parseDecimalTr("abc", 2)).toBeNull();
    expect(parseDecimalTr("1.000,5", 2)).toBeNull();
  });

  it("N3: blank is null", () => {
    expect(parseDecimalTr("", 2)).toBeNull();
    expect(parseDecimalTr("   ", 2)).toBeNull();
  });
});

describe("parseTlToCents", () => {
  it("N4: Turkish and plain notation", () => {
    expect(parseTlToCents("1.500,50")).toBe(150050);
    expect(parseTlToCents("1500,5")).toBe(150050);
    expect(parseTlToCents("1500.50")).toBe(150050);
    expect(parseTlToCents("0,01")).toBe(1);
    expect(parseTlToCents("1500.5")).toBe(150050);
    expect(parseTlToCents("1.500")).toBe(150000);
  });

  it("N5: more than 2 decimals, negatives and blanks are null", () => {
    expect(parseTlToCents("1,005")).toBeNull();
    expect(parseTlToCents("-5")).toBeNull();
    expect(parseTlToCents("")).toBeNull();
    expect(parseTlToCents("0")).toBeNull();
  });

  it("round-trips through the input format", () => {
    expect(centsToTlInput(150050)).toBe("1500,50");
    expect(parseTlToCents(centsToTlInput(150050))).toBe(150050);
    expect(formatTl(150050)).toBe("₺1.500,50");
    expect(formatDecimalTr(3.75)).toBe("3,75");
  });
});
