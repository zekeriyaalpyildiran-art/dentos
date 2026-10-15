// Workbook FX hook (spec p5 §7, acceptance A24): the 'GÜNCEL DÖVİZ' rates are offered for saving as clinic fx_rates.
// Synthetic data only.

import { describe, expect, it } from "vitest";
import { workbookCashBalance } from "../balances";
import { intakeSpreadsheet } from "../detect";
import { parseWorkbook, workbookFxRates } from "../workbook";
import type { SheetBook } from "../types";
import { LAYOUT, seedRules } from "./fixtures";

const book = (sheets: Record<string, unknown[][]>): SheetBook => ({ names: Object.keys(sheets), sheets });
const row = (cells: Record<number, unknown>) => {
  const r: unknown[] = Array(19).fill(null);
  for (const [k, v] of Object.entries(cells)) r[Number(k)] = v;
  return r;
};
const receipt = (no: number) => row({ 0: no, 1: "Örnek Hasta", 2: 100 });
const MONTH = "2026-09";
const fx = (rows: unknown[][], days: Record<string, unknown[][]> = { "01": [["h"], receipt(1)] }) =>
  book({ ...days, TOPLAM: [], "GÜNCEL DÖVİZ": rows });
const ratesOf = (b: SheetBook, file = "test.xlsx") =>
  workbookFxRates(b, LAYOUT, MONTH, workbookCashBalance(b, LAYOUT, MONTH, file).activeDays, file);

describe("workbookFxRates", () => {
  it("legacy fixture shape gives EUR 55 on the last active day", () => {
    const r = ratesOf(fx([[null, null, null, "EUR", 55]]));
    expect(r).toEqual({ on: "2026-09-01", file: "test.xlsx", items: [{ currency: "EUR", rate: "55.000000" }] });
  });

  it("is dated on the last day sheet with activity, not the last sheet", () => {
    const r = ratesOf(
      fx([[null, null, null, "USD", 45.5]], {
        "01": [["h"], receipt(1)],
        "07": [["h"], receipt(1)],
        "30": [["h"], row({ 0: 1, 1: "Boş satır" })],
      })
    );
    expect(r?.on).toBe("2026-09-07");
    expect(r?.items).toEqual([{ currency: "USD", rate: "45.500000" }]);
  });

  it("returns null without an active day", () => {
    expect(ratesOf(fx([[null, null, null, "EUR", 55]], { "01": [["h"]] }))).toBeNull();
  });

  it("drops zero, negative and > 1000 rates; null when none is left", () => {
    expect(
      ratesOf(
        fx([
          [null, null, null, "EUR", 0],
          [null, null, null, "USD", -3],
          [null, null, null, "GBP", 1000.5],
        ])
      )
    ).toBeNull();
    const r = ratesOf(fx([[null, null, null, "EUR", 1000], [null, null, null, "USD", 0]]));
    expect(r?.items).toEqual([{ currency: "EUR", rate: "1000.000000" }]);
  });

  it("rounds to 6 decimals and the first row wins", () => {
    const r = ratesOf(
      fx([
        [null, null, null, "EUR", 49.8765432],
        [null, null, null, "EUR", 60],
        [null, null, null, "GBP", 0.0000004],
        [null, null, null, "USD", 0.1234565],
      ])
    );
    expect(r?.items).toEqual([
      { currency: "EUR", rate: "49.876543" },
      { currency: "USD", rate: "0.123457" },
    ]);
  });

  it("intakeSpreadsheet returns the rates and leaves the parsed rows unchanged", () => {
    const b = fx([[null, null, null, "EUR", 55]], { "01": [["h"], row({ 0: 1, 1: "Örnek Hasta", 2: 100, 4: 2 })] });
    const rules = seedRules();
    const out = intakeSpreadsheet(b, { file: "t.xlsx", month: MONTH, layouts: [{ id: "l", layout: LAYOUT }], rules });
    expect(out.kind).toBe("workbook");
    if (out.kind !== "workbook") return;
    expect(out.rates?.items).toEqual([{ currency: "EUR", rate: "55.000000" }]);
    expect(out.rates?.on).toBe("2026-09-01");
    expect(out.result).toEqual(parseWorkbook(b, { file: "t.xlsx", month: MONTH, layout: LAYOUT, rules }));
  });
});
