// Macro report import (hakediş v2, 0033): parser and buildMacroImport. Made-up doctors, patients, operations and
// amounts only; the headers are the Macro report headers. The optional real-file test reads the directory in
// DENTOS_MACRO_SAMPLES (never copied into the repo) and is skipped when it is unset; it asserts structure and
// reconciliation only, and its failure messages name the check, never a value from the files.

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildMacroImport,
  detectMacroReport,
  macroBasisOf,
  macroDefaultRange,
  macroDoctorsInRange,
  macroFirstOpenDay,
  monthsOfRange,
  validateMacroRange,
  excelSerialToDay,
  macroCents,
  macroCurrency,
  macroDay,
  macroDayRange,
  macroExtDoctors,
  macroHeaderKey,
  macroMethod,
  macroMethodTotals,
  macroNameKey,
  macroRowOfError,
  MACRO_LIMITS,
  MACRO_REPORT_LABELS,
  MacroImportError,
  MacroParseError,
  monthEndOf,
  parseMacroSheet,
  readMacroFile,
  type MacroImportInput,
  type MacroPaymentRow,
  type MacroTreatmentRow,
} from "../hakedis-macro";
import type { HkImportLineArg } from "../hakedis";

const TL = (n: number) => Math.round(n * 100);

const T_HEADER = ["TARİH", "DOKTOR", "OPERASYON", "DİŞ", "D. NO", "HASTA", "PRIM TİPİ", "TUTARI", "MASRAF", "KESİLEN KDV", "ACENTE PRİM", "%", "PRİM TUTARI", "PARA"];
const P_HEADER = ["ÖDEME", "TARİH", "DOKTOR", "HASTA", "OPERASYON", "DİŞ", "PRIM TİPİ", "ÖDENEN", "Ö. ORANI", "İŞLEM", "MASRAF", "KESİNTİ", "KDV", "ACENTE", "%", "PRİM", "PARA", "KORUMA"];

/** Excel serial of a 'YYYY-MM-DD' day (1900 system). */
const serial = (day: string) => Math.round((Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86_400_000);

let rowNo = 1;
function tr(p: Partial<MacroTreatmentRow> & Pick<MacroTreatmentRow, "amount_cents">): MacroTreatmentRow {
  return {
    row: ++rowNo,
    day: "2026-11-10",
    ext_doctor: "Hekim A",
    procedure: "Kompozit Dolgu",
    tooth: "36",
    patient_no: "101",
    patient_name: "Hasta Bir",
    currency: "TRY",
    ...p,
  };
}
function pay(
  t: Pick<MacroTreatmentRow, "day" | "ext_doctor" | "procedure" | "tooth" | "patient_name" | "currency">,
  p: Partial<MacroPaymentRow> & Pick<MacroPaymentRow, "amount_cents">
): MacroPaymentRow {
  return {
    row: ++rowNo,
    pay_day: t.day,
    treatment_day: t.day,
    ext_doctor: t.ext_doctor,
    patient_name: t.patient_name,
    procedure: t.procedure,
    tooth: t.tooth,
    method: "cash",
    currency: t.currency,
    ...p,
  };
}
const build = (p: Partial<MacroImportInput> & Pick<MacroImportInput, "treatments">) =>
  buildMacroImport({ payments: [], from: "2026-11-01", to: "2026-11-30", orthoExtDoctors: new Set(), ...p });
/** The lines of one treatments row: method → amount. */
const partsOf = (lines: readonly HkImportLineArg[], t: MacroTreatmentRow) =>
  Object.fromEntries(lines.filter((l) => l.key.startsWith(`t${t.row}:`)).map((l) => [l.method, l.amount_cents]));

describe("cell values", () => {
  it("matches headers without case, spaces, dots or Turkish letters", () => {
    expect(macroHeaderKey("D. NO")).toBe("dno");
    expect(macroHeaderKey("Ö. ORANI")).toBe("oorani");
    expect(macroHeaderKey("TUTARI")).toBe("tutari");
    expect(macroHeaderKey("İŞLEM")).toBe("islem");
    expect(macroHeaderKey(" kesilen  kdv ")).toBe("kesilenkdv");
    expect(detectMacroReport(T_HEADER)).toBe("treatments");
    expect(detectMacroReport(P_HEADER)).toBe("payments");
    expect(detectMacroReport(["tarih", "doktor", "operasyon", "hasta", "tutari"])).toBe("treatments");
    expect(detectMacroReport(["Odeme", "Tarih", "Doktor", "Hasta", "Operasyon", "Odenen", "Islem"])).toBe("payments");
    expect(detectMacroReport(["TARİH", "AÇIKLAMA", "TUTAR"])).toBeNull();
  });

  it("turns Excel serials, dates and text into days", () => {
    expect(excelSerialToDay(serial("2026-11-02"))).toBe("2026-11-02");
    expect(excelSerialToDay(serial("2026-11-02") + 0.75)).toBe("2026-11-02");
    expect(excelSerialToDay(1)).toBe("1900-01-01");
    expect(excelSerialToDay(59)).toBe("1900-02-28");
    expect(excelSerialToDay(60)).toBeNull(); // Excel's 1900-02-29
    expect(excelSerialToDay(61)).toBe("1900-03-01");
    expect(excelSerialToDay(0)).toBeNull();
    expect(excelSerialToDay(0, true)).toBe("1904-01-01");
    expect(excelSerialToDay(serial("2026-11-02") - 1462, true)).toBe("2026-11-02");
    expect(macroDay(new Date(2026, 10, 2))).toBe("2026-11-02");
    expect(macroDay("02.11.2026")).toBe("2026-11-02");
    expect(macroDay("2/11/2026")).toBe("2026-11-02");
    expect(macroDay("2026-11-02")).toBe("2026-11-02");
    expect(macroDay("31.11.2026")).toBeNull();
    expect(macroDay("")).toBeNull();
    expect(macroDay(null)).toBeNull();
  });

  it("rounds amounts to cents half away from zero on the decimal value", () => {
    expect(macroCents(1500)).toBe(150000);
    expect(macroCents(0.125)).toBe(13);
    expect(macroCents(1.005)).toBe(101);
    expect(macroCents(-0.125)).toBe(-13);
    expect(macroCents(1234.5678901234)).toBe(123457);
    expect(macroCents(0)).toBe(0);
    expect(macroCents(-0)).toBe(0);
    expect(macroCents("1.234,56")).toBe(123456);
    expect(macroCents("1234.5")).toBe(123450);
    expect(macroCents("12 TL")).toBe(1200);
    expect(macroCents("abc")).toBeNull();
    expect(macroCents(null)).toBeNull();
    expect(macroCents(Number.NaN)).toBeNull();
  });

  it("maps PARA and İŞLEM", () => {
    expect(macroCurrency("TL")).toBe("TRY");
    expect(macroCurrency("DOLAR")).toBe("USD");
    expect(macroCurrency("EURO")).toBe("EUR");
    expect(macroCurrency("STERLİN")).toBe("GBP");
    expect(macroCurrency("usd")).toBe("USD");
    expect(macroCurrency("€")).toBe("EUR");
    expect(macroCurrency(null)).toBe("TRY");
    expect(macroCurrency("YEN")).toBeNull();
    expect(macroMethod("Nakit")).toBe("cash");
    expect(macroMethod("POS")).toBe("card");
    expect(macroMethod("Kredi Kartı")).toBe("card");
    expect(macroMethod("Banka")).toBe("transfer");
    expect(macroMethod("Havale")).toBe("transfer");
    expect(macroMethod("Çek")).toBeNull();
  });

  it("knows the last day of a month", () => {
    expect(monthEndOf("2026-11-10")).toBe("2026-11-30");
    expect(monthEndOf("2028-02-03")).toBe("2028-02-29");
    expect(monthEndOf("2026-12-31")).toBe("2026-12-31");
  });
});

describe("parseMacroSheet", () => {
  it("reads a treatments report, skipping title, blank and total rows", () => {
    const rows = [
      ["Örnek rapor başlığı"],
      [],
      T_HEADER,
      [serial("2026-11-02"), "Hekim A", "Kompozit Dolgu", 36, 101, "Hasta Bir", null, 1500, 0, 0, 0, 0, 0, "TL"],
      [serial("2026-11-03"), "Hekim B", "Detertraj", "31,32, 33", "202", "Hasta İki", null, 0, 0, 0, 0, 0, 0, "DOLAR"],
      [null, null, null, null, null, null, null, 1500, null, null, null, null, null, null],
      [],
    ];
    const r = parseMacroSheet(rows, { file: "islem.xls" });
    expect(r.kind).toBe("treatments");
    expect(r.issues).toEqual([]);
    expect(r.rows).toEqual([
      {
        row: 4,
        day: "2026-11-02",
        ext_doctor: "Hekim A",
        procedure: "Kompozit Dolgu",
        tooth: "36",
        patient_no: "101",
        patient_name: "Hasta Bir",
        currency: "TRY",
        amount_cents: 150000,
      },
      {
        row: 5,
        day: "2026-11-03",
        ext_doctor: "Hekim B",
        procedure: "Detertraj",
        tooth: "31,32, 33",
        patient_no: "202",
        patient_name: "Hasta İki",
        currency: "USD",
        amount_cents: 0,
      },
    ]);
  });

  it("reads a payments report and reports unreadable rows", () => {
    const rows = [
      P_HEADER,
      [serial("2026-10-28"), serial("2026-11-02"), "Hekim A", "Hasta Bir", "Kompozit Dolgu", 36, null, 750.255, 50.017, "POS", 0, 9, 0, 0, 0, 0, "TL", false],
      [serial("2026-11-05"), serial("2026-11-02"), "Hekim A", "Hasta Bir", "Kompozit Dolgu", 36, null, 100, 6.6, "Çek", 0, 0, 0, 0, 0, 0, "TL", false],
      ["dün", serial("2026-11-02"), "Hekim A", "Hasta Bir", "Kompozit Dolgu", 36, null, "x", 0, "Nakit", 0, 0, 0, 0, 0, 0, "YEN", false],
    ];
    const r = parseMacroSheet(rows);
    expect(r.kind).toBe("payments");
    expect(r.rows).toEqual([
      {
        row: 2,
        pay_day: "2026-10-28",
        treatment_day: "2026-11-02",
        ext_doctor: "Hekim A",
        patient_name: "Hasta Bir",
        procedure: "Kompozit Dolgu",
        tooth: "36",
        method: "card",
        currency: "TRY",
        amount_cents: 75026,
      },
    ]);
    expect(r.issues).toEqual([
      { row: 3, reason: "Ödeme şekli tanınmadı: Çek." },
      { row: 4, reason: "Para birimi tanınmadı: YEN. Ödeme tarihi okunamadı. Ödenen tutar okunamadı." },
    ]);
  });

  it("lists rows the server would refuse by its field limits, with their file row", () => {
    const rows = [
      T_HEADER,
      [serial("2026-11-02"), "H".repeat(121), "Kompozit Dolgu", 36, "9".repeat(51), "Hasta Bir", null, 15, 0, 0, 0, 0, 0, "TL"],
      [serial("2026-11-02"), "Hekim A", "x".repeat(201), "y".repeat(201), 101, "Hasta Bir", null, 20_000_000_000, 0, 0, 0, 0, 0, "TL"],
      [serial("2026-11-02"), "H".repeat(120), "x".repeat(200), "y".repeat(200), "9".repeat(50), "Hasta Bir", null, 10_000_000_000, 0, 0, 0, 0, 0, "TL"],
    ];
    const r = parseMacroSheet(rows);
    expect(r.issues).toEqual([
      { row: 2, reason: "Hekim adı en fazla 120 karakter olabilir. Hasta dosya numarası en fazla 50 karakter olabilir." },
      {
        row: 3,
        reason: "İşlem adı en fazla 200 karakter olabilir. Diş bilgisi en fazla 200 karakter olabilir. Tutar en fazla 10.000.000.000 olabilir.",
      },
    ]);
    // At the limits: read.
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ row: 4, amount_cents: MACRO_LIMITS.amount_cents });
    const pays = parseMacroSheet([
      P_HEADER,
      [serial("2026-11-05"), serial("2026-11-02"), "Hekim A", "h".repeat(201), "Kompozit Dolgu", 36, null, -20_000_000_000, 0, "Nakit", 0, 0, 0, 0, 0, 0, "TL", false],
    ]);
    expect(pays.issues).toEqual([
      { row: 2, reason: "Hasta adı en fazla 200 karakter olabilir. Tutar en fazla 10.000.000.000 olabilir." },
    ]);
  });

  it("refuses a file that is not a Macro report, or misses a column", () => {
    expect(() => parseMacroSheet([["Ad", "Soyad"], ["x", "y"]], { file: "liste.xls" })).toThrow(MacroParseError);
    expect(() => parseMacroSheet([["Ad", "Soyad"]], { file: "liste.xls" })).toThrow(/liste\.xls: Macro raporu tanınmadı/);
    // Treatments header without HASTA.
    expect(() => parseMacroSheet([T_HEADER.filter((h) => h !== "HASTA")])).toThrow(/HASTA sütunu yok/);
  });
});

describe("readMacroFile", () => {
  async function xls(rows: unknown[][]): Promise<ArrayBuffer> {
    const X = await import("xlsx");
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(rows), "Sheet1");
    return X.write(wb, { type: "array", bookType: "biff8" }) as ArrayBuffer;
  }

  it("reads both legacy .xls reports by their headers", async () => {
    const X = await import("xlsx");
    const t = await readMacroFile(
      await xls([T_HEADER, [serial("2026-11-02"), "Hekim A", "Kompozit Dolgu", 36, 101, "Hasta Bir", null, 1500.5, 0, 0, 0, 0, 0, "TL"]]),
      "islem.xls",
      X
    );
    expect(t.kind).toBe("treatments");
    expect(t.file).toBe("islem.xls");
    expect(t.rows).toMatchObject([{ row: 2, day: "2026-11-02", tooth: "36", patient_no: "101", amount_cents: 150050 }]);
    const p = await readMacroFile(
      await xls([P_HEADER, [serial("2026-11-01"), serial("2026-11-02"), "Hekim A", "Hasta Bir", "Kompozit Dolgu", 36, null, 500, 33.3, "Banka", 0, 0, 0, 0, 0, 0, "EURO", false]]),
      "odeme.xls"
    );
    expect(p.kind).toBe("payments");
    expect(p.rows).toMatchObject([{ pay_day: "2026-11-01", treatment_day: "2026-11-02", method: "transfer", currency: "EUR", amount_cents: 50000 }]);
  });

  it("refuses other files with a Turkish message", async () => {
    await expect(readMacroFile(await xls([["Ad"], ["x"]]), "liste.xls")).rejects.toThrow(/Macro raporu tanınmadı/);
    await expect(readMacroFile(new Uint8Array([1, 2, 3]).buffer, "bozuk.xls")).rejects.toThrow(MacroParseError);
  });
});

describe("buildMacroImport: production basis", () => {
  it("owner example shape: the part paid in the month by its method, the rest unpaid", () => {
    const t = tr({ amount_cents: TL(60_000) });
    const out = build({ treatments: [t], payments: [pay(t, { amount_cents: TL(30_000), method: "cash" })] });
    expect(partsOf(out.lines, t)).toEqual({ cash: TL(30_000), unpaid: TL(30_000) });
    expect(out.lines[0]).toEqual({
      key: `t${t.row}:cash`,
      basis: "production",
      day: "2026-11-10",
      treatment_day: "2026-11-10",
      ext_doctor: "Hekim A",
      patient_name: "Hasta Bir",
      patient_no: "101",
      procedure: "Kompozit Dolgu",
      tooth: "36",
      method: "cash",
      currency: "TRY",
      amount_cents: TL(30_000),
    });
  });

  it("splits card and transfer parts and sums several payments per method", () => {
    const t = tr({ amount_cents: TL(10_000) });
    const out = build({
      treatments: [t],
      payments: [
        pay(t, { amount_cents: TL(2_000), method: "card", pay_day: "2026-11-10" }),
        pay(t, { amount_cents: TL(1_500), method: "transfer", pay_day: "2026-11-12" }),
        pay(t, { amount_cents: TL(3_000), method: "card", pay_day: "2026-11-20" }),
        pay(t, { amount_cents: TL(500.25), method: "cash", pay_day: "2026-11-30" }),
      ],
    });
    expect(partsOf(out.lines, t)).toEqual({ cash: TL(500.25), card: TL(5_000), transfer: TL(1_500), unpaid: TL(2_999.75) });
    // Method order: cash, card, transfer, unpaid.
    expect(out.lines.map((l) => l.method)).toEqual(["cash", "card", "transfer", "unpaid"]);
  });

  it("counts a payment after the end of the treatment's month as unpaid", () => {
    const t = tr({ amount_cents: TL(8_000), day: "2026-11-28" });
    const out = build({
      treatments: [t],
      payments: [
        pay(t, { amount_cents: TL(3_000), method: "card", pay_day: "2026-11-30" }),
        pay(t, { amount_cents: TL(5_000), method: "card", pay_day: "2026-12-01" }),
      ],
    });
    expect(partsOf(out.lines, t)).toEqual({ card: TL(3_000), unpaid: TL(5_000) });
  });

  it("counts an advance paid before the treatment with its method", () => {
    const t = tr({ amount_cents: TL(4_000), day: "2026-11-05" });
    const out = build({
      treatments: [t],
      payments: [pay(t, { amount_cents: TL(4_000), method: "transfer", pay_day: "2026-09-20" })],
    });
    expect(partsOf(out.lines, t)).toEqual({ transfer: TL(4_000) });
  });

  it("caps an overpayment at the price (earliest payments first)", () => {
    const t = tr({ amount_cents: TL(1_000) });
    const out = build({
      treatments: [t],
      payments: [
        pay(t, { amount_cents: TL(700), method: "card", pay_day: "2026-11-11" }),
        pay(t, { amount_cents: TL(800), method: "cash", pay_day: "2026-11-10" }),
      ],
    });
    expect(partsOf(out.lines, t)).toEqual({ cash: TL(800), card: TL(200) });
    expect(out.stats.overpaid).toEqual([{ currency: "TRY", cents: TL(500) }]);
  });

  it("fills identical treatments rows in file order", () => {
    const a = tr({ amount_cents: TL(1_000) });
    const b = tr({ amount_cents: TL(1_000) });
    const out = build({
      treatments: [a, b],
      payments: [
        pay(a, { amount_cents: TL(700), method: "cash", pay_day: "2026-11-10" }),
        pay(a, { amount_cents: TL(1_000), method: "card", pay_day: "2026-11-11" }),
      ],
    });
    expect(partsOf(out.lines, a)).toEqual({ cash: TL(700), card: TL(300) });
    expect(partsOf(out.lines, b)).toEqual({ card: TL(700), unpaid: TL(300) });
  });

  it("matches payments by day, patient, operation, tooth and currency with normalized text", () => {
    const t1 = tr({ amount_cents: TL(1_000), patient_name: "HASTA  İKİ", procedure: "Diş Çekimi", tooth: "31,32" });
    const t2 = tr({ amount_cents: TL(1_000), patient_name: "Hasta İki", procedure: "Diş Çekimi", tooth: "33" });
    const out = build({
      treatments: [t1, t2],
      payments: [
        pay(t1, { patient_name: "hasta iki", procedure: "DİŞ ÇEKİMİ", tooth: "31, 32", amount_cents: TL(1_000) }),
        // Same treatment but another currency: no match.
        pay(t2, { currency: "USD", amount_cents: TL(10) }),
      ],
    });
    expect(partsOf(out.lines, t1)).toEqual({ cash: TL(1_000) });
    expect(partsOf(out.lines, t2)).toEqual({ unpaid: TL(1_000) });
    expect(out.stats.unmatched_payments).toHaveLength(1);
    expect(out.stats.unmatched_payments[0]).toMatchObject({ currency: "USD", amount_cents: TL(10) });
  });

  it("takes a refund back from the treatment, never changing a month after its end", () => {
    const t = tr({ amount_cents: TL(2_000), day: "2026-11-10" });
    const within = build({
      treatments: [t],
      payments: [
        pay(t, { amount_cents: TL(2_000), method: "card", pay_day: "2026-11-10" }),
        pay(t, { amount_cents: TL(-500), method: "card", pay_day: "2026-11-15" }),
      ],
    });
    expect(partsOf(within.lines, t)).toEqual({ card: TL(1_500), unpaid: TL(500) });
    const later = build({
      treatments: [t],
      payments: [
        pay(t, { amount_cents: TL(2_000), method: "card", pay_day: "2026-11-10" }),
        pay(t, { amount_cents: TL(-500), method: "card", pay_day: "2026-12-02" }),
      ],
    });
    expect(partsOf(later.lines, t)).toEqual({ card: TL(2_000) });
  });

  it("takes a refund paid back by another method from the other methods' parts of the month", () => {
    const t = tr({ amount_cents: TL(1_100), day: "2026-11-10" });
    const cashBack = build({
      treatments: [t],
      payments: [
        pay(t, { amount_cents: TL(1_100), method: "card", pay_day: "2026-11-10" }),
        pay(t, { amount_cents: TL(-450), method: "cash", pay_day: "2026-11-15" }),
      ],
    });
    expect(partsOf(cashBack.lines, t)).toEqual({ card: TL(650), unpaid: TL(450) });
    const cardBack = build({
      treatments: [t],
      payments: [
        pay(t, { amount_cents: TL(1_100), method: "cash", pay_day: "2026-11-10" }),
        pay(t, { amount_cents: TL(-1_100), method: "card", pay_day: "2026-11-20" }),
      ],
    });
    expect(partsOf(cardBack.lines, t)).toEqual({ unpaid: TL(1_100) });
    // The same refund after the end of the treatment's month changes nothing.
    const later = build({
      treatments: [t],
      payments: [
        pay(t, { amount_cents: TL(1_100), method: "card", pay_day: "2026-11-10" }),
        pay(t, { amount_cents: TL(-450), method: "cash", pay_day: "2026-12-03" }),
      ],
    });
    expect(partsOf(later.lines, t)).toEqual({ card: TL(1_100) });
    for (const out of [cashBack, cardBack, later]) {
      expect(out.lines.reduce((sum, l) => sum + l.amount_cents, 0)).toBe(TL(1_100));
    }
  });

  it("gives a zero-price row a piece but no line; a negative price one negative unpaid line", () => {
    const free = tr({ amount_cents: 0, procedure: "Kontrol" });
    const minus = tr({ amount_cents: TL(-300), procedure: "İndirim" });
    const out = build({ treatments: [free, minus], payments: [pay(free, { amount_cents: TL(100) })] });
    expect(partsOf(out.lines, free)).toEqual({});
    expect(partsOf(out.lines, minus)).toEqual({ unpaid: TL(-300) });
    expect(out.pieces.map((p) => p.key)).toEqual([`t${free.row}`, `t${minus.row}`]);
    expect(out.pieces[0]).toEqual({
      key: `t${free.row}`,
      day: "2026-11-10",
      ext_doctor: "Hekim A",
      patient_name: "Hasta Bir",
      patient_no: "101",
      procedure: "Kontrol",
      tooth: "36",
      qty: 1,
    });
    expect(out.stats.negative_rows).toBe(1);
    expect(out.stats.overpaid).toEqual([{ currency: "TRY", cents: TL(100) }]);
    expect(out.stats.doctors[0]).toMatchObject({ treatments: 2, zero_price: 1, pieces: 2, lines: 1 });
  });

  it("passes foreign currencies through (the server converts them)", () => {
    const t = tr({ amount_cents: TL(150), currency: "EUR" });
    const out = build({ treatments: [t], payments: [pay(t, { amount_cents: TL(100), method: "card" })] });
    expect(out.lines.map((l) => [l.method, l.currency, l.amount_cents])).toEqual([
      ["card", "EUR", TL(100)],
      ["unpaid", "EUR", TL(50)],
    ]);
    expect(out.stats.currencies).toEqual(["EUR"]);
    expect(macroMethodTotals(out.stats.doctors[0], "EUR")).toEqual({ cash: 0, card: TL(100), transfer: 0, unpaid: TL(50) });
    expect(macroMethodTotals(out.stats.doctors[0], "TRY")).toEqual({ cash: 0, card: 0, transfer: 0, unpaid: 0 });
  });

  it("emits only the days of the range; a payment for a treatment outside it is ignored", () => {
    const before = tr({ amount_cents: TL(500), day: "2026-10-31" });
    const inside = tr({ amount_cents: TL(500), day: "2026-11-01" });
    const after = tr({ amount_cents: TL(500), day: "2026-12-01" });
    const out = build({
      treatments: [before, inside, after],
      payments: [
        pay(before, { amount_cents: TL(500), pay_day: "2026-11-03" }),
        pay({ ...inside, day: "2026-09-01" }, { amount_cents: TL(10) }),
      ],
    });
    expect(out.lines.map((l) => l.key)).toEqual([`t${inside.row}:unpaid`]);
    expect(out.pieces.map((p) => p.key)).toEqual([`t${inside.row}`]);
    expect(out.stats.unmatched_payments).toEqual([]);
  });

  it("leaves out ignored doctors and refuses a bad range", () => {
    const t = tr({ amount_cents: TL(500), ext_doctor: "ESKİ HEKİM" });
    const out = build({ treatments: [t], ignoreExtDoctors: new Set(["eski hekim"]) });
    expect(out.lines).toEqual([]);
    expect(out.pieces).toEqual([]);
    expect(out.stats.doctors).toMatchObject([{ ext_doctor: "ESKİ HEKİM", ignored: true, treatments: 1, pieces: 0 }]);
    expect(() => build({ treatments: [], from: "2026-11-30", to: "2026-11-01" })).toThrow(MacroImportError);
    expect(() => build({ treatments: [], from: "2026-11-31", to: "2026-12-01" })).toThrow(/Tarih aralığını seçin/);
  });
});

describe("buildMacroImport: payment basis (orthodontist)", () => {
  it("emits the orthodontist's payments of the range, no production lines", () => {
    const tOld = tr({ amount_cents: TL(20_000), ext_doctor: "Ortodontist Ö", day: "2026-06-10", patient_name: "Hasta Üç", patient_no: "303", procedure: "Tel Tedavisi", tooth: null });
    const tNew = tr({ amount_cents: TL(5_000), ext_doctor: "Ortodontist Ö", day: "2026-11-12", patient_name: "Hasta Üç", patient_no: "303", procedure: "Kontrol", tooth: null });
    const other = tr({ amount_cents: TL(1_000), ext_doctor: "Ortodontist Ö", day: "2026-11-12", patient_name: "Hasta Dört", patient_no: null, procedure: "Kontrol", tooth: null });
    const payments = [
      pay(tOld, { amount_cents: TL(2_500), method: "card", pay_day: "2026-11-03" }),
      pay(tOld, { amount_cents: TL(2_500), method: "cash", pay_day: "2026-10-03" }), // before the range
      pay(other, { amount_cents: TL(400), method: "transfer", pay_day: "2026-11-20" }),
      pay(other, { amount_cents: 0, pay_day: "2026-11-21" }),
    ];
    const out = build({ treatments: [tOld, tNew, other], payments, orthoExtDoctors: new Set(["ORTODONTİST ö"]) });
    expect(out.lines).toEqual([
      {
        key: `p${payments[0].row}`,
        basis: "payment",
        day: "2026-11-03",
        treatment_day: "2026-06-10",
        ext_doctor: "Ortodontist Ö",
        patient_name: "Hasta Üç",
        patient_no: "303",
        procedure: "Tel Tedavisi",
        tooth: null,
        method: "card",
        currency: "TRY",
        amount_cents: TL(2_500),
      },
      expect.objectContaining({ key: `p${payments[2].row}`, basis: "payment", method: "transfer", patient_no: null, amount_cents: TL(400) }),
    ]);
    // Pieces are still one per treatments row in the range.
    expect(out.pieces.map((p) => p.key)).toEqual([`t${tNew.row}`, `t${other.row}`]);
    expect(out.stats.doctors).toMatchObject([{ basis: "payment", payments: 2, lines: 2, treatments: 2, pieces: 2 }]);
  });

  it("gives no patient number when the name has several in the treatments report", () => {
    const a = tr({ amount_cents: TL(100), ext_doctor: "Ortodontist Ö", patient_name: "Hasta Beş", patient_no: "501" });
    const b = tr({ amount_cents: TL(100), ext_doctor: "Hekim A", patient_name: "Hasta Beş", patient_no: "502" });
    const out = build({ treatments: [a, b], payments: [pay(a, { amount_cents: TL(100) })], orthoExtDoctors: new Set(["Ortodontist Ö"]) });
    expect(out.lines.find((l) => l.basis === "payment")).toMatchObject({ patient_no: null });
  });
});

describe("buildMacroImport: preview stats", () => {
  it("lists doctors and distinct operations with their rows", () => {
    const rows = [
      tr({ amount_cents: TL(100), ext_doctor: "Hekim B", procedure: "Diş Çekimi" }),
      tr({ amount_cents: 0, ext_doctor: "KLİNİK ÖRNEK", procedure: "DİŞ  ÇEKİMİ" }),
      tr({ amount_cents: TL(100), ext_doctor: "Hekim A", procedure: "Kanal Tedavisi" }),
    ];
    const out = build({ treatments: rows });
    expect(out.stats.doctors.map((d) => [d.ext_doctor, d.key, d.basis])).toEqual([
      ["Hekim A", "hekim a", "production"],
      ["Hekim B", "hekim b", "production"],
      ["KLİNİK ÖRNEK", "klinik örnek", "production"],
    ]);
    expect(out.stats.operations).toEqual([
      { key: "diş çekimi", name: "Diş Çekimi", rows: 2, ext_doctors: ["Hekim B", "KLİNİK ÖRNEK"] },
      { key: "kanal tedavisi", name: "Kanal Tedavisi", rows: 1, ext_doctors: ["Hekim A"] },
    ]);
    expect(macroExtDoctors(rows, [{ ext_doctor: "hekim a" }, { ext_doctor: "Hekim C" }])).toEqual([
      { key: "hekim a", name: "Hekim A" },
      { key: "hekim b", name: "Hekim B" },
      { key: "hekim c", name: "Hekim C" },
      { key: "klinik örnek", name: "KLİNİK ÖRNEK" },
    ]);
    expect(macroDayRange(rows.map((r, i) => ({ ...r, day: `2026-11-1${i}` })))).toEqual({ from: "2026-11-10", to: "2026-11-12" });
    expect(macroDayRange([])).toBeNull();
  });
});

describe("macroRowOfError", () => {
  it("names the patient and report row of a server row error from the payload sent", () => {
    const t = tr({ amount_cents: TL(1_100), patient_name: "Hasta Yedi" });
    const p = pay(tr({ amount_cents: 0, ext_doctor: "Hekim O", patient_name: "Hasta Sekiz" }), {
      amount_cents: TL(300),
      pay_day: "2026-11-12",
    });
    const out = build({ treatments: [t], payments: [p], orthoExtDoctors: new Set(["Hekim O"]) });
    const lineN = out.lines.findIndex((l) => l.patient_name === "Hasta Sekiz") + 1;
    expect(lineN).toBeGreaterThan(0);
    expect(macroRowOfError(`Macro yüklemesi, ${lineN}. satır (12.11.2026): tutar geçersiz.`, out)).toBe(
      `${lineN}. satır: Hasta Sekiz · ${MACRO_REPORT_LABELS.payments}, ${p.row}. satır`
    );
    expect(macroRowOfError("Macro yüklemesi, 1. işlem (10.11.2026): adet geçersiz.", out)).toBe(
      `1. işlem: Hasta Yedi · ${MACRO_REPORT_LABELS.treatments}, ${t.row}. satır`
    );
    expect(macroRowOfError("Macro yüklemesi, 99. satır (10.11.2026): x", out)).toBeNull();
    expect(macroRowOfError("Döviz kuru bulunamadı: EUR (05.11.2026).", out)).toBeNull();
    expect(macroRowOfError(null, out)).toBeNull();
    expect(macroRowOfError("Macro yüklemesi, 1. satır (10.11.2026): x", null)).toBeNull();
  });
});

describe("import page helpers", () => {
  const OPEN = [{ month: "2026-09-01", status: "closed" as const }, { month: "2026-10-01", status: "open" as const }];

  it("lists the months of a range", () => {
    expect(monthsOfRange("2026-11-15", "2027-02-01")).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
    expect(monthsOfRange("2026-11-15", "2026-11-20")).toEqual(["2026-11"]);
    expect(monthsOfRange("2026-11-20", "2026-11-15")).toEqual([]);
    expect(monthsOfRange("2026-02-30", "2026-03-01")).toEqual([]);
  });

  it("mirrors the server's range checks", () => {
    const today = "2026-12-05";
    expect(validateMacroRange("2026-10-01", "2026-11-30", today, OPEN)).toBeNull();
    expect(validateMacroRange("", "2026-11-30", today, OPEN)).toBe("Tarih aralığını seçin.");
    expect(validateMacroRange("2026-11-30", "2026-11-01", today, OPEN)).toBe("Başlangıç tarihi bitiş tarihinden sonra olamaz.");
    expect(validateMacroRange("1999-12-01", "2000-01-02", today, [])).toBe("Geçersiz tarih.");
    expect(validateMacroRange("2026-11-01", "2026-12-06", today, OPEN)).toBe("Bitiş tarihi bugünden sonra olamaz.");
    // 366 days at most (p_to − p_from <= 365).
    expect(validateMacroRange("2025-12-05", "2026-12-05", today, [])).toBeNull();
    expect(validateMacroRange("2025-12-04", "2026-12-05", today, [])).toBe("Bir yüklemede en fazla 366 günlük aralık seçilebilir.");
    expect(validateMacroRange("2026-09-20", "2026-10-10", today, OPEN)).toBe(
      "Seçilen aralıkta kapatılmış bir ay var (09.2026). Macro yüklemesi yalnızca açık aylara yapılabilir."
    );
    expect(validateMacroRange("2026-08-01", "2026-08-31", today, OPEN)).toBe(
      "Seçilen aralıktan sonraki bir ay kapatıldı (09.2026). Kapatılmış aydan önceki günler artık yüklenemez."
    );
  });

  it("defaults to the whole months of the report, after the last closed month and until today at the latest", () => {
    expect(macroFirstOpenDay(OPEN)).toBe("2026-10-01");
    expect(macroFirstOpenDay([{ month: "2026-12", status: "closed" }])).toBe("2027-01-01");
    expect(macroFirstOpenDay([])).toBeNull();
    // Whole months: an orthodontist's payment on the 1st or the 30th counts even without a treatment that day.
    expect(macroDefaultRange([{ day: "2026-11-03" }, { day: "2026-11-27" }], "2026-12-05", OPEN)).toEqual({
      from: "2026-11-01",
      to: "2026-11-30",
    });
    const rows = [{ day: "2026-09-28" }, { day: "2026-10-03" }, { day: "2026-12-04" }];
    expect(macroDefaultRange(rows, "2026-12-05", OPEN)).toEqual({ from: "2026-10-01", to: "2026-12-05" });
    expect(macroDefaultRange([{ day: "2026-09-02" }], "2026-12-05", OPEN)).toBeNull();
    expect(macroDefaultRange([], "2026-12-05", OPEN)).toBeNull();
  });

  it("makes a mapped doctor payment based only when an ortho rule covers every month of the range", () => {
    const rules = [
      { kind: "ortho_lab_first" as const, doctor_id: "doc-o", from_month: "2026-01-01", to_month: null },
      { kind: "ortho_lab_first" as const, doctor_id: "doc-p", from_month: "2026-11-01", to_month: null },
      { kind: "ciro_share" as const, doctor_id: "doc-a", from_month: "2026-01-01", to_month: null },
    ];
    const mapping = [
      { ext_name: "hekim o", display_name: "HEKİM O", mode: "doctor" as const, doctor_id: "doc-o" },
      { ext_name: "hekim p", display_name: "HEKİM P", mode: "doctor" as const, doctor_id: "doc-p" },
      { ext_name: "hekim a", display_name: "HEKİM A", mode: "doctor" as const, doctor_id: "doc-a" },
      { ext_name: "klinik örnek", display_name: "KLİNİK ÖRNEK", mode: "clinic" as const, doctor_id: null },
    ];
    expect(macroBasisOf({ rules, mapping, from: "2026-11-01", to: "2026-11-30" })).toEqual({
      ortho: new Set(["hekim o", "hekim p"]),
      mixed: [],
    });
    expect(macroBasisOf({ rules, mapping, from: "2026-10-15", to: "2026-11-30" })).toEqual({
      ortho: new Set(["hekim o"]),
      mixed: ["HEKİM P"],
    });
    expect(macroBasisOf({ rules, mapping, from: "", to: "2026-11-30" })).toEqual({ ortho: new Set(), mixed: [] });
  });

  it("names the Macro doctors an import of the range sends", () => {
    const t = [
      tr({ amount_cents: TL(100), ext_doctor: "Hekim A", day: "2026-11-10" }),
      tr({ amount_cents: TL(100), ext_doctor: "Hekim B", day: "2026-10-10" }),
    ];
    const p = [
      pay(t[1], { amount_cents: TL(50), ext_doctor: "Hekim C", pay_day: "2026-11-02", treatment_day: "2026-10-10" }),
      pay(t[1], { amount_cents: TL(50), ext_doctor: "Hekim D", pay_day: "2026-10-20", treatment_day: "2026-10-10" }),
    ];
    expect(macroDoctorsInRange(t, p, "2026-11-01", "2026-11-30")).toEqual(new Set(["hekim a", "hekim c"]));
  });
});

// ---------------------------------------------------------------------------
// Optional: the clinic's real Macro exports (never in the repo)
// ---------------------------------------------------------------------------

const SAMPLES = process.env.DENTOS_MACRO_SAMPLES;
const samplesEnabled = !!SAMPLES && existsSync(SAMPLES);

describe.skipIf(!samplesEnabled)("real Macro samples (DENTOS_MACRO_SAMPLES)", () => {
  it("parses every report and reconciles each production doctor with the treatments report", async () => {
    const X = await import("xlsx");
    const files = readdirSync(SAMPLES as string).filter((n) => /\.xlsx?$/i.test(n));
    const treatments: MacroTreatmentRow[][] = [];
    const payments: MacroPaymentRow[][] = [];
    for (const name of files) {
      const bytes = readFileSync(join(SAMPLES as string, name));
      const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const r = await readMacroFile(data, name, X);
      expect(r.issues.length === 0, "okunamayan satır var").toBe(true);
      if (r.kind === "treatments") treatments.push(r.rows);
      else payments.push(r.rows);
    }
    expect(treatments.length > 0 && payments.length > 0, "işlem ve ödeme raporu bulunmalı").toBe(true);
    for (const t of treatments) {
      const range = macroDayRange(t);
      expect(!!range, "işlem raporunda satır yok").toBe(true);
      for (const p of payments) {
        const out = buildMacroImport({ treatments: t, payments: p, from: range!.from, to: range!.to, orthoExtDoctors: new Set() });
        expect(out.pieces.length === t.length, "her işlem satırı bir adet olmalı").toBe(true);
        expect(out.lines.every((l) => l.day >= range!.from && l.day <= range!.to), "aralık dışı satır").toBe(true);
        expect(out.lines.every((l) => l.amount_cents !== 0), "0 tutarlı satır").toBe(true);
        // fin__hk_macro_row limits (a row outside them would refuse the whole import).
        const fits = (r: { key: string; patient_name: string; ext_doctor: string; patient_no: string | null; procedure: string; tooth: string | null }) =>
          r.key.length <= 100 &&
          r.patient_name.trim().length >= 1 &&
          r.patient_name.trim().length <= 200 &&
          r.ext_doctor.trim().length >= 1 &&
          r.ext_doctor.trim().length <= 120 &&
          (r.patient_no ?? "").length <= 50 &&
          r.procedure.length <= 200 &&
          (r.tooth ?? "").length <= 200;
        expect(out.lines.every(fits) && out.pieces.every(fits), "sunucu alan sınırı aşılıyor").toBe(true);
        expect(out.lines.every((l) => l.treatment_day >= "2000-01-01"), "2000 öncesi işlem tarihi").toBe(true);
        for (const d of out.stats.doctors) {
          for (const total of d.totals) {
            const expected = t
              .filter((r) => r.currency === total.currency && r.amount_cents > 0 && macroNameKey(r.ext_doctor) === d.key)
              .reduce((sum, r) => sum + r.amount_cents, 0);
            const negative = t
              .filter((r) => r.currency === total.currency && r.amount_cents < 0 && macroNameKey(r.ext_doctor) === d.key)
              .reduce((sum, r) => sum + r.amount_cents, 0);
            expect(total.gross_cents === expected + negative, "hekim toplamı işlem raporuyla uyuşmuyor").toBe(true);
          }
        }
      }
    }
  });
});
