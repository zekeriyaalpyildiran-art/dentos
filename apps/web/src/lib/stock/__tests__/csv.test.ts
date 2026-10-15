// CSV export rules (spec p8_purchasing §10.5, §14).

import { describe, expect, it } from "vitest";
import { CSV_BOM, csvCents, csvNumber, csvText, qtyCell, tlCell, toCsv } from "../csv";

describe("toCsv", () => {
  it("starts with the BOM, separates with ';', ends lines with CRLF and has no trailing line end", () => {
    const text = toCsv([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(text.startsWith(CSV_BOM)).toBe(true);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.slice(1)).toBe("a;b\r\nc;d");
    expect(text.endsWith("\r\n")).toBe(false);
  });

  it("writes number cells from numbers without a formula prefix", () => {
    expect(toCsv([[-3, qtyCell(2.5), tlCell(-150)]]).slice(1)).toBe("-3;2,5;-1,5");
  });

  it("keeps Turkish characters", () => {
    expect(toCsv([["İğneşğ", "Şırınga"]]).slice(1)).toBe("İğneşğ;Şırınga");
  });
});

describe("csvText", () => {
  it("prefixes formula starters with an apostrophe", () => {
    expect(csvText("=1+1")).toBe("'=1+1");
    expect(csvText("+90 555")).toBe("'+90 555");
    expect(csvText("-SUM(A1)")).toBe("'-SUM(A1)");
    expect(csvText("@cmd")).toBe("'@cmd");
    expect(csvText("\t x")).toBe("'\t x");
    expect(csvText("\r x")).toBe("\"'\r x\"");
  });

  it("quotes cells with ; \" or line breaks and doubles inner quotes", () => {
    expect(csvText("a;b")).toBe('"a;b"');
    expect(csvText('5" ped')).toBe('"5"" ped"');
    expect(csvText("line\nbreak")).toBe('"line\nbreak"');
    expect(csvText("plain")).toBe("plain");
    expect(csvText(null)).toBe("");
  });
});

describe("csvNumber / csvCents", () => {
  it("uses a decimal comma without thousands grouping", () => {
    expect(csvNumber(2.5, 4)).toBe("2,5");
    expect(csvNumber(-3, 4)).toBe("-3");
    expect(csvNumber(1234567.891, 2)).toBe("1234567,89");
    expect(csvNumber(0.0001, 4)).toBe("0,0001");
    expect(csvNumber(-0, 4)).toBe("0");
  });

  it("writes an empty cell for null", () => {
    expect(csvNumber(null)).toBe("");
    expect(csvNumber(undefined)).toBe("");
    expect(csvNumber(Number.NaN)).toBe("");
    expect(csvCents(null)).toBe("");
  });

  it("formats cents exactly", () => {
    expect(csvCents(123456)).toBe("1234,56");
    expect(csvCents(1250)).toBe("12,5");
    expect(csvCents(100)).toBe("1");
    expect(csvCents(-5)).toBe("-0,05");
    expect(csvCents(0)).toBe("0");
  });
});
