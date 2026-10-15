import { describe, expect, it } from "vitest";
import { compileRules } from "../classify";
import { validateWorkbookLayout, WORKBOOK_LAYOUT_TEMPLATE, layoutTerms } from "../layout";
import { isClinicWorkbook, parseWorkbook } from "../workbook";
import { workbookCashBalance } from "../balances";
import type { SheetBook } from "../types";
import { entitlementRule, LAYOUT, SEED_RULES, seedRules } from "./fixtures";

const book = (sheets: Record<string, unknown[][]>): SheetBook => ({ names: Object.keys(sheets), sheets });
const row = (cells: Record<number, unknown>) => {
  const r: unknown[] = Array(19).fill(null);
  for (const [k, v] of Object.entries(cells)) r[Number(k)] = v;
  return r;
};
const rates = [[null, null, null, "EUR", 55], [null, null, null, "USD", 50], [null, null, null, "GBP", 60]];
const opts = (month = "2026-09", rules = seedRules()) => ({ file: "test.xlsx", month, layout: LAYOUT, rules });

describe("layout", () => {
  it("template validates and keeps legacy term order", () => {
    expect(validateWorkbookLayout(WORKBOOK_LAYOUT_TEMPLATE).ok).toBe(true);
    expect(layoutTerms(LAYOUT.receipt).map((t) => `${t.col}${t.fx ?? ""}`)).toEqual(["2", "4EUR", "5USD", "6GBP", "7", "8"]);
    expect(layoutTerms(LAYOUT.expense).map((t) => `${t.col}${t.fx ?? ""}`)).toEqual(["13EUR", "14USD", "15GBP", "16", "17", "18"]);
  });
  it("rejects unknown keys, bad columns and bad patterns", () => {
    const bad = JSON.parse(JSON.stringify(WORKBOOK_LAYOUT_TEMPLATE));
    bad.extra = 1;
    bad.fx_code_col = 300;
    bad.receipt.skip_name_pattern = "(";
    bad.expense.eur_cols = [16];
    const v = validateWorkbookLayout(bad);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe("workbook parser (TFI:19-24)", () => {
  it("missing formula note, currency exchange unselected, entitlement rule from config", () => {
    const expense = row({ 11: "ÖRNEK SAHİP ADI", 16: 108675 });
    const fx = row({ 11: "DÖVİZ BOZDURMA", 16: -100, 13: 2 });
    const rules = compileRules([...SEED_RULES, entitlementRule("örnek sahip")]);
    const p = parseWorkbook(book({ "01": [["header"], expense, fx], TOPLAM: [], "GÜNCEL DÖVİZ": [[null, null, null, "EUR", 55]] }), opts("2026-09", rules));
    expect(p.rows[0].amount).toBe(10867500);
    expect(p.rows[0].selected).toBe(false);
    expect(p.rows[0].bucket).toBe("doctor");
    expect(p.rows[0].requiresEntitlementMonth).toBe(true);
    expect(p.rows[0].warnings[0].code).toBe("W_ENTITLEMENT_MONTH");
    expect(p.rows[0].key).toBe("clinic:2026-09-01:expense:2");
    expect(p.notes.some((n) => n.includes("boş"))).toBe(true);
    expect(p.rows[1].selected).toBe(false);
    expect(p.rows[1].warnings[0].code).toBe("W_FX_EXCHANGE");
    expect(p.rows[1].amount).toBe(1000); // 2*55 - 100 = 10 TL
  });
  it("receipts are summed per row then per day and rounded once (C11)", () => {
    const t = [
      ["no", "name"],
      row({ 0: 1, 1: "A", 2: 100.105, 5: 1.5 }),
      row({ 0: 2, 1: "B", 7: 0.2, 8: 0.1 }),
      row({ 0: 3, 1: "TOPLAM", 2: 999 }),
      row({ 0: "x", 1: "C", 2: 999 }), // row number not numeric
      row({ 0: 4, 1: null, 2: 999 }), // name not a string
      row({ 0: 5, 1: "", 2: 1 }), // empty string name counts
    ];
    const p = parseWorkbook(book({ "01": t, TOPLAM: [], "GÜNCEL DÖVİZ": rates }), opts());
    const r = p.rows.find((x) => x.kind === "workbook_receipts")!;
    const gross = 0 + (100.105 + 0 * 55 + 1.5 * 50 + 0 * 60 + 0 + 0) + (0 + 0 + 0 + 0 + 0.2 + 0.1) + (1 + 0 + 0 + 0 + 0 + 0);
    expect(r.amount).toBe(Math.round(gross * 100));
    expect(r.key).toBe("clinic:2026-09-01:receipts");
    expect(r.legacyAccount).toBe("Karma");
    expect(r.selected).toBe(true);
    expect(r.meta.fxApplied).toBe(true);
    expect(r.meta.contributingRows).toBe(3);
  });
  it("bank-paid expenses are 'Banka'; generic rules do not unselect workbook rows", () => {
    const t = [["h"], row({ 11: "Bilinmeyen gider", 17: 50 }), row({ 11: "Kira", 16: 10 }), row({ 11: "GİDERLER TOPLAMI", 16: 5 })];
    const p = parseWorkbook(book({ "01": t, TOPLAM: [] }), opts());
    expect(p.rows).toHaveLength(2);
    expect(p.rows[0].legacyAccount).toBe("Banka");
    expect(p.rows[0].bucket).toBe("other_expense");
    expect(p.rows[0].selected).toBe(true);
    expect(p.rows[0].warnings).toEqual([]);
    expect(p.rows[1].bucket).toBe("rent");
    expect(p.rows[1].legacyAccount).toBe("Nakit");
  });
  it("missing rates stop the file", () => {
    expect(() => parseWorkbook(book({ "01": [["h"], row({ 0: 1, 1: "A", 4: 10 })], TOPLAM: [] }), opts())).toThrow(/kur eksik/);
    expect(() => parseWorkbook(book({ "01": [["h"], row({ 11: "x", 14: 10 })], TOPLAM: [] }), opts())).toThrow(/Dövizli çıkış/);
    // no FX amount → no rate needed
    expect(() => parseWorkbook(book({ "01": [["h"], row({ 0: 1, 1: "A", 2: 10 })], TOPLAM: [] }), opts())).not.toThrow();
  });
  it("month comes from the picker; invalid days are skipped; negative totals become issues (D4)", () => {
    const sheets = { "30": [["h"], row({ 0: 1, 1: "A", 2: 10 })], "31": [["h"], row({ 0: 1, 1: "A", 2: 10 })], "01": [["h"], row({ 0: 1, 1: "A", 2: -5 })], TOPLAM: [] };
    const p = parseWorkbook(book(sheets), opts("2026-09"));
    expect(p.rows.map((r) => r.key)).toEqual(["clinic:2026-09-30:receipts"]);
    expect(p.issues).toHaveLength(1);
    expect(parseWorkbook(book(sheets), opts("2026-10")).rows.map((r) => r.key)).toEqual([
      "clinic:2026-10-30:receipts",
      "clinic:2026-10-31:receipts",
    ]);
  });
  it("D17: negative expense totals become issues, never inflow rows under an expense key", () => {
    const t = [["h"], row({ 11: "İade", 16: -250 }), row({ 11: "Kira", 16: 10 })];
    const p = parseWorkbook(book({ "01": t, TOPLAM: [] }), opts());
    expect(p.rows.map((r) => r.key)).toEqual(["clinic:2026-09-01:expense:3"]);
    expect(p.rows.every((r) => r.signedCents < 0)).toBe(true);
    expect(p.issues).toHaveLength(1);
    expect(p.issues[0].reason).toMatch(/eksi veya sıfır/);
  });
  it("empty skip patterns skip nothing (DB allows 0..200 characters)", () => {
    const layout = { ...LAYOUT, receipt: { ...LAYOUT.receipt, skip_name_pattern: "" }, expense: { ...LAYOUT.expense, skip_desc_pattern: "" } };
    expect(validateWorkbookLayout(layout).ok).toBe(true);
    const t = [["h"], row({ 0: 1, 1: "TOPLAM", 2: 5 }), row({ 11: "TOPLAM", 16: 7 })];
    const p = parseWorkbook(book({ "01": t, TOPLAM: [] }), { ...opts(), layout });
    expect(p.rows.map((r) => [r.kind, r.amount])).toEqual([
      ["workbook_expense", 700],
      ["workbook_receipts", 500],
    ]);
  });
  it("layout validation matches fin__layout_config bounds", () => {
    const ok = JSON.parse(JSON.stringify(WORKBOOK_LAYOUT_TEMPLATE));
    ok.first_row = 5000;
    delete ok.cash.EUR;
    ok.fx_sheet = "S".repeat(100);
    expect(validateWorkbookLayout(ok).ok).toBe(true);
    const bad = JSON.parse(JSON.stringify(WORKBOOK_LAYOUT_TEMPLATE));
    bad.receipt_text.description = "x".repeat(901);
    delete bad.cash.TRY;
    bad.day_sheet_pattern = "(\\d+)+$";
    const v = validateWorkbookLayout(bad);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join(" ")).toMatch(/receipt_text\.description.*cash\.TRY|cash\.TRY.*receipt_text/s);
    if (!v.ok) expect(v.errors.some((e) => e.startsWith("day_sheet_pattern"))).toBe(true);
  });
  it("detection uses the layout's required sheets", () => {
    expect(isClinicWorkbook(book({ "01": [], TOPLAM: [] }), LAYOUT)).toBe(true);
    expect(isClinicWorkbook(book({ "01": [] }), LAYOUT)).toBe(false);
  });
});

describe("workbook cash (TFI:79-82)", () => {
  it("chooses the last day with real activity, not prefilled days", () => {
    const t = (active: boolean) => [[1, active ? "Patient" : null, active ? 100 : null], ["KASA (TL)", "KASA (EURO)", "KASA (DOLAR)", "KASA (STERLİN)"], [100, 2, 0, 0]];
    const s = { "01": t(true), "26": t(true), "27": t(false), TOPLAM: [], "GÜNCEL DÖVİZ": [[null, null, null, "EUR", 50]] };
    const r = workbookCashBalance(book(s), LAYOUT, "2026-09", "test.xlsx");
    expect(r.source?.day).toBe("2026-09-26");
    expect(r.source?.amountCents).toBe(20000);
    expect(r.source?.importKey).toBe("clinic-cash");
    expect(r.source?.note.startsWith("100 TL + 2 EUR × 50 + 0 USD + 0 GBP.")).toBe(true);
  });
  it("a currency without a cash label is not on the sheet", () => {
    const layout = { ...LAYOUT, cash: { TRY: LAYOUT.cash.TRY } };
    const t = [[1, "P", 100], ["KASA (TL)"], [250]];
    const r = workbookCashBalance(book({ "01": t, TOPLAM: [] }), layout, "2026-09", "x");
    expect([r.error, r.source?.amountCents, r.source?.note.startsWith("250 TL.")]).toEqual([null, 25000, true]);
  });
  it("invalid cash cells and missing rates are errors", () => {
    const t = [[1, "P", 100], ["KASA (TL)", "KASA (EURO)", "KASA (DOLAR)"], [100, 2, 0]];
    expect(workbookCashBalance(book({ "01": t, TOPLAM: [], "GÜNCEL DÖVİZ": rates }), LAYOUT, "2026-09", "x").error).toMatch(/Kasa bakiyesi/);
    const u = [[1, "P", 100], ["KASA (TL)", "KASA (EURO)", "KASA (DOLAR)", "KASA (STERLİN)"], [100, 2, 0, 0]];
    expect(workbookCashBalance(book({ "01": u, TOPLAM: [] }), LAYOUT, "2026-09", "x").error).toMatch(/kur eksik/);
  });
});
