import { describe, expect, it } from "vitest";
import {
  bankDate,
  bankNumber,
  bankText,
  financeDayOk,
  isoDate,
  normB,
  normM,
  normTr,
  trMoney,
  trNumber,
  addDays,
  maskFileName,
  optionalPattern,
} from "../primitives";

describe("trNumber / isoDate (FI:5-6)", () => {
  it("parses Turkish text to a TL float", () => {
    expect(trNumber("-0,46")).toBe(-0.46);
    expect(trNumber("4.000,00")).toBe(4000);
    expect(trNumber("1.000.000,10")).toBe(1000000.1);
    expect(Object.is(trNumber("-0,00"), -0)).toBe(true);
    expect(`${trNumber("-0,00")}`).toBe("0");
    expect(trNumber("")).toBe(0);
    expect(trNumber("27.413,09 TL")).toBe(27413.09);
    expect(Number.isNaN(trNumber("abc"))).toBe(true);
    expect(trNumber(12.5)).toBe(12.5);
  });
  it("accepts only dd.mm.yyyy and dd/mm/yyyy without a calendar check", () => {
    expect(isoDate("07.10.2026")).toBe("2026-10-07");
    expect(isoDate("07/10/2026")).toBe("2026-10-07");
    expect(isoDate("31.02.2026")).toBe("2026-02-31");
    expect(isoDate("7.10.2026")).toBe("");
    expect(isoDate("07.10.2026 10:00")).toBe("");
  });
  it("normTr lower-cases in Turkish and collapses whitespace", () => {
    expect(normTr("  İSTANBUL   KIRA ")).toBe("istanbul kıra");
  });
});

describe("bankDate / bankNumber (BT:6-19, TBT:9)", () => {
  it("validates calendar dates and Excel serials", () => {
    expect(bankDate("31.02.2026")).toBe("");
    expect(bankDate("2026-10-03 11:20")).toBe("2026-10-03");
    expect(bankDate(46298)).toBe("2026-10-03");
    expect(bankDate("3.10.2026")).toBe("2026-10-03");
    expect(bankDate("03/10/2026")).toBe("2026-10-03");
    expect(bankDate(31415.92)).not.toBe(""); // a balance "looks like a date" (§1.2)
    expect(bankDate("nope")).toBe("");
  });
  it("D2: Date cells use the local calendar day", () => {
    const localMidnight = new Date(2026, 9, 3, 0, 0, 0);
    expect(bankDate(localMidnight)).toBe("2026-10-03");
    expect(bankText(localMidnight)).toBe("2026-10-03");
    expect(bankDate(new Date(NaN))).toBe("");
  });
  it("parses tr/en numbers into cents", () => {
    expect(bankNumber("1.234,56", "tr")).toBe(123456);
    expect(bankNumber("1,234.56", "en")).toBe(123456);
    expect(bankNumber("1,234.56", "tr")).toBe(null);
    expect(bankNumber("(150,00)", "tr")).toBe(-15000);
    expect(bankNumber(1234.56, "tr")).toBe(123456);
    expect(bankNumber(14807.720000000008, "tr")).toBe(1480772);
    expect(bankNumber(4.35, "tr")).toBe(435); // 4.35 * 100 = 434.99999999999994
    expect(bankNumber("", "tr")).toBe(0);
    expect(bankNumber("-", "tr")).toBe(0);
    expect(bankNumber("150,00-", "tr")).toBe(-15000);
    expect(bankNumber("1.234,56 TL", "tr")).toBe(123456);
    expect(bankNumber(Infinity, "tr")).toBe(null);
  });
  it("normB strips accents and folds ı", () => {
    expect(normB(" İşlem  Tarihi ")).toBe("islem tarihi");
    expect(normB("Açıklama")).toBe("aciklama");
    expect(normB(null)).toBe("");
  });
});

describe("misc", () => {
  it("financeDayOk", () => {
    expect(financeDayOk("2026-10-15")).toBe(true);
    expect(financeDayOk("2026-02-31")).toBe(false);
    expect(financeDayOk("2026-1-5")).toBe(false);
  });
  it("trMoney formats cents as Turkish money text", () => {
    expect(trMoney(1480772)).toBe("14.807,72");
    expect(trMoney(0)).toBe("0,00");
    expect(trMoney(-123456789)).toBe("-1.234.567,89");
    expect(trMoney(5)).toBe("0,05");
  });
  it("normM folds for matching", () => {
    expect(normM("ÖDEME - Şirket A.Ş.")).toBe("odeme sirket a s");
  });
  it("maskFileName hides account-number runs and bounds the length", () => {
    expect(maskFileName("00123456789012345.pdf")).toBe("…2345.pdf");
    expect(maskFileName("Hesap Hareketleri (2).xlsx")).toBe("Hesap Hareketleri (2).xlsx");
    expect(maskFileName("Belge-2026-03-14-11-48-31.pdf")).toBe("Belge-2026-03-14-11-48-31.pdf");
    expect(maskFileName("x".repeat(300))).toHaveLength(200);
    expect(maskFileName("   ")).toBe("Dosya");
  });
  it("optionalPattern: empty never matches", () => {
    expect(optionalPattern("", "i").test("anything")).toBe(false);
    expect(optionalPattern("toplam", "i").test("GENEL TOPLAM")).toBe(true);
  });
  it("addDays", () => {
    expect(addDays("2026-10-03", 30)).toBe("2026-11-02");
  });
});
