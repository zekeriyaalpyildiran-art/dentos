// Finance import, parser A: the clinic daily workbook (spec p2i_parsers_rules §4; legacy FI:45-71).
//
// Config-driven: every column, sheet name and text comes from the saved layout row. The float
// evaluation order and the rounding units are legacy's (C11): receipts are summed row by row in
// array order and rounded once per day; each expense row is rounded once.

import { classify, workbookFirstPass, type CompiledRules } from "./classify";
import { layoutTerms, type FxCode, type Term, type WorkbookLayout } from "./layout";
import { financeDayOk, hasOwn, monthOk, optionalPattern } from "./primitives";
import { legacySubcategory, workbookExpenseKey, workbookReceiptsKey } from "./keys";
import { ImportParseError, warning, type ParseResult, type ParsedRow, type RowWarning, type SheetBook } from "./types";

export const WORKBOOK_FINAL_NOTE =
  "Klinik Excel’i: günlük ayrıntılar okundu. Döviz tutarları dosyadaki kurla TL’ye çevrildi. Bankadaki POS yatışlarını ayrıca tahsilat olarak eklemeyin.";

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** §3.1 step 2: the book contains every sheet the layout requires. */
export function isClinicWorkbook(book: SheetBook, layout: WorkbookLayout): boolean {
  return layout.required_sheets.every((name) => hasOwn(book.sheets, name));
}

export type Rates = Record<FxCode, number>;

/** §4.2 (FI:48): first row with the code wins; a missing rate is 0. */
export function workbookRates(book: SheetBook, layout: WorkbookLayout): Rates {
  const table = hasOwn(book.sheets, layout.fx_sheet) ? book.sheets[layout.fx_sheet] : [];
  const rate = (code: FxCode) => Number(table.find((r) => r[layout.fx_code_col] === code)?.[layout.fx_rate_col] || 0);
  return { EUR: rate("EUR"), USD: rate("USD"), GBP: rate("GBP") };
}

/** Reference rates read from the fx sheet, to be saved as clinic fx_rates (spec p5 §7). `rate` is TL per 1 unit. */
export type WorkbookFxRates = { on: string; file: string; items: { currency: FxCode; rate: string }[] };

const FX_CODES: readonly FxCode[] = ["EUR", "USD", "GBP"];
const MAX_RATE_MICRO = 1_000_000_000; // 1000 TL per unit

/** Micro units (rate × 1e6) printed with exactly 6 decimals, e.g. 49876543 → '49.876543' (no float formatting). */
const microText = (micro: number): string => {
  const s = String(micro).padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
};

/**
 * Rates of the fx sheet (same reading as workbookRates: the first row with the code wins), dated on the last day
 * sheet with activity (`activeDays` from workbookCashBalance), so a month imported later is dated by its own last
 * working day. null when the month has no active day, or when no rate is positive and ≤ 1000. Zero, negative and
 * larger values are dropped. A day sheet without activity is never used: the last sheet of a template month may lie
 * in the future, and a future rate date is refused by the database. Pure: never changes parseWorkbook's rows.
 */
export function workbookFxRates(
  book: SheetBook,
  layout: WorkbookLayout,
  month: string,
  activeDays: readonly string[],
  file: string,
): WorkbookFxRates | null {
  if (!monthOk(month)) return null;
  const day = activeDays[activeDays.length - 1];
  if (!day) return null;
  const on = month + "-" + day;
  if (!financeDayOk(on)) return null;
  const rates = workbookRates(book, layout);
  const items: WorkbookFxRates["items"] = [];
  for (const currency of FX_CODES) {
    const r = rates[currency];
    if (!Number.isFinite(r) || !(r > 0) || r > 1000) continue;
    const micro = Math.round(r * 1e6);
    if (micro < 1 || micro > MAX_RATE_MICRO) continue;
    items.push({ currency, rate: microText(micro) });
  }
  return items.length ? { on, file: file.slice(0, 200), items } : null;
}

/** Valid day sheets of the month, in book order: [sheet name, 'YYYY-MM-DD']. */
export function daySheets(book: SheetBook, layout: WorkbookLayout, month: string): [string, string][] {
  const re = new RegExp(layout.day_sheet_pattern);
  const out: [string, string][] = [];
  for (const name of book.names) {
    if (!hasOwn(book.sheets, name) || !re.test(name)) continue;
    const date = month + "-" + name;
    if (financeDayOk(date)) out.push([name, date]);
  }
  return out;
}

const termValue = (r: unknown[], t: Term, rates: Rates): number => (t.fx ? num(r[t.col]) * rates[t.fx] : num(r[t.col]));
/** Left-to-right sum of the terms (legacy `a+b*eur+…`). 0 + x === x, so the reduce seed is exact. */
const rowSum = (r: unknown[], terms: Term[], rates: Rates): number => terms.reduce((s, t) => s + termValue(r, t, rates), 0);
const missingRate = (r: unknown[], terms: Term[], rates: Rates): boolean =>
  terms.some((t) => t.fx !== undefined && num(r[t.col]) !== 0 && !rates[t.fx]);
const fxUsed = (r: unknown[], terms: Term[]): boolean => terms.some((t) => t.fx !== undefined && num(r[t.col]) !== 0);

export type WorkbookParseOptions = {
  file: string;
  /** The user's chosen import month 'YYYY-MM' (day sheet names become days of it). */
  month: string;
  layout: WorkbookLayout;
  rules: CompiledRules;
};

/**
 * Parses the day sheets. Throws ImportParseError for a missing rate (whole file fails, FI:56/59).
 * A negative daily receipts total is reported as an issue instead of a row (D4).
 */
export function parseWorkbook(book: SheetBook, opts: WorkbookParseOptions): ParseResult {
  const { layout, month, rules } = opts;
  const file = opts.file.slice(0, 200);
  if (!monthOk(month)) throw new ImportParseError("Aktarım ayını seçin.");
  const rates = workbookRates(book, layout);
  const rTerms = layoutTerms(layout.receipt);
  const eTerms = layoutTerms(layout.expense);
  const skipName = optionalPattern(layout.receipt.skip_name_pattern, "i");
  const skipDesc = optionalPattern(layout.expense.skip_desc_pattern, "i");
  const { row_no_col: noCol, name_col: nameCol } = layout.receipt;
  const { desc_col: descCol, total_col: totalCol, bank_cols: bankCols } = layout.expense;
  const rows: ParsedRow[] = [];
  const notes: string[] = [];
  const issues: ParseResult["issues"] = [];

  for (const [name, date] of daySheets(book, layout, month)) {
    const table = book.sheets[name];
    let gross = 0;
    let contributing = 0;
    let fxApplied = false;
    for (let i = layout.first_row; i < table.length; i++) {
      const r = table[i];
      if (!r) continue;
      if (typeof r[noCol] === "number" && missingRate(r, rTerms, rates))
        throw new ImportParseError("Dövizli tahsilat var, ancak dosyada kur eksik.");
      if (typeof r[noCol] === "number" && typeof r[nameCol] === "string" && !skipName.test(r[nameCol] as string)) {
        gross += rowSum(r, rTerms, rates);
        contributing++;
        if (fxUsed(r, rTerms)) fxApplied = true;
      }
      const desc = String(r[descCol] || "").trim();
      if (!desc || skipDesc.test(desc)) continue;
      if (missingRate(r, eTerms, rates)) throw new ImportParseError("Dövizli çıkış var, ancak dosyada kur eksik.");
      const val = rowSum(r, eTerms, rates);
      if (!val) continue;
      const amount = Math.round(Math.abs(val) * 100);
      if (val < 0 || amount < 1) {
        // D17: an expense-section row with a negative (or sub-cent) total is not an outflow. Legacy booked it as an
        // inflow under an 'expense:N' key; the database refuses that key on an inflow, so it is reported instead.
        issues.push({
          line: i + 1,
          sheet: name,
          reason: `${date}: ${desc} gider satırının tutarı eksi veya sıfır; satır aktarılamaz. İade / düzeltme ise finans listesinden elle girin.`,
        });
        continue;
      }
      const signedCents = -amount; // legacy classify(desc, -val)
      const cls = classify(rules, desc, -val, "clinic", { firstPass: workbookFirstPass });
      const isEntitlement = !!cls?.requiresEntitlementMonth;
      // Workbook selection ignores the generic rules (FI:64); only workbook-scoped rules
      // (e.g. the currency-exchange rule) and entitlement rules can unselect a row.
      const flagRule = !!cls && (cls.scope === "clinic" || isEntitlement);
      const fxRow = fxUsed(r, eTerms);
      const warnings: RowWarning[] = [];
      if (flagRule && cls?.warning) warnings.push(cls.warning);
      else if (isEntitlement) warnings.push(warning("W_ENTITLEMENT_MONTH"));
      else if (fxRow) warnings.push(warning("W_FX_RATE"));
      const formulaCellEmpty = r[totalCol] == null;
      rows.push({
        key: workbookExpenseKey(date, i),
        kind: "workbook_expense",
        sourceKind: "clinic_excel",
        file,
        date,
        description: desc,
        amount,
        signedCents,
        bucket: cls?.bucket ?? null,
        categoryId: cls?.categoryId ?? null,
        subcategory: legacySubcategory(cls?.bucket ?? null, desc),
        // A configured counterparty is used only for entitlement rows (IP:54); every other row keeps its narration.
        counterpartyId: isEntitlement ? (cls?.counterpartyId ?? null) : null,
        requiresEntitlementMonth: isEntitlement,
        ruleId: cls?.ruleId ?? null,
        legacyAccount: bankCols.some((c) => num(r[c]) !== 0) ? "Banka" : "Nakit",
        accountImportKey: null,
        selected: !isEntitlement && !(flagRule && !cls?.autoSelect),
        warnings,
        entitlementMonth: null,
        meta: { sheet: name, line: i + 1, fxApplied: fxRow, formulaCellEmpty },
      });
      if (formulaCellEmpty)
        notes.push(`${name}. gün, ${i + 1}. satır: toplam hücresi boş; ${desc} için ödeme sütunundan ${val.toLocaleString("tr-TR")} TL okundu.`);
    }
    if (gross) {
      const amount = Math.round(gross * 100);
      if (amount < 1) {
        issues.push({ line: 0, sheet: name, reason: `${date}: günlük tahsilat toplamı sıfır veya eksi; satır aktarılamaz.` });
        continue;
      }
      rows.push({
        key: workbookReceiptsKey(date),
        kind: "workbook_receipts",
        sourceKind: "clinic_excel",
        file,
        date,
        description: layout.receipt_text.description,
        amount,
        signedCents: amount,
        bucket: "patient_receipts",
        categoryId: null,
        subcategory: null,
        counterpartyId: null,
        requiresEntitlementMonth: false,
        ruleId: null,
        legacyAccount: "Karma",
        accountImportKey: null,
        selected: true,
        warnings: [],
        entitlementMonth: null,
        meta: { sheet: name, fxApplied, contributingRows: contributing },
      });
    }
  }
  notes.push(WORKBOOK_FINAL_NOTE);
  return { rows, notes, issues };
}
