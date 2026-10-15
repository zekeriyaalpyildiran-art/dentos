// Finance import: clinic workbook layout (fin_import_layouts.config, kind 'clinic_workbook';
// p2i_db_contract §2.7, p2i_parsers_rules §4.1).
//
// The column map is clinic data and lives in the database. The parser reads only the saved
// layout it is given; WORKBOOK_LAYOUT_TEMPLATE is offered by the settings screen as a pre-filled
// starting point and is never used as a silent fallback.

import { regexSafetyProblem } from "./classify";

export type WorkbookLayout = {
  version: 1;
  required_sheets: string[];
  day_sheet_pattern: string;
  fx_sheet: string;
  fx_code_col: number;
  fx_rate_col: number;
  /** First array index scanned on a day sheet (legacy loop starts at 1: index 0 is the header). */
  first_row: number;
  receipt: {
    row_no_col: number;
    name_col: number;
    skip_name_pattern: string;
    try_cols: number[];
    eur_cols: number[];
    usd_cols: number[];
    gbp_cols: number[];
  };
  expense: {
    desc_col: number;
    total_col: number;
    skip_desc_pattern: string;
    try_cols: number[];
    eur_cols: number[];
    usd_cols: number[];
    gbp_cols: number[];
    bank_cols: number[];
  };
  /** Header labels of the cash cells; TRY is required, a missing currency is not on the sheet. */
  cash: { TRY: string; EUR?: string; USD?: string; GBP?: string };
  receipt_text: { counterparty: string; description: string };
};

export type FxCode = "EUR" | "USD" | "GBP";
export type Term = { col: number; fx?: FxCode };

/** Legacy column map of the clinic workbook (FI:47-67, BI:13-19), as a starting template. */
export const WORKBOOK_LAYOUT_TEMPLATE: WorkbookLayout = {
  version: 1,
  required_sheets: ["01", "TOPLAM"],
  day_sheet_pattern: "^\\d{2}$",
  fx_sheet: "GÜNCEL DÖVİZ",
  fx_code_col: 3,
  fx_rate_col: 4,
  first_row: 1,
  receipt: {
    row_no_col: 0,
    name_col: 1,
    skip_name_pattern: "TOPLAM",
    try_cols: [2, 7, 8],
    eur_cols: [4],
    usd_cols: [5],
    gbp_cols: [6],
  },
  expense: {
    desc_col: 11,
    total_col: 12,
    skip_desc_pattern: "TOPLAM|KALAN|GELEN|GİDERLER",
    try_cols: [16, 17, 18],
    eur_cols: [13],
    usd_cols: [14],
    gbp_cols: [15],
    bank_cols: [17, 18],
  },
  cash: { TRY: "KASA\\s*\\(TL\\)", EUR: "KASA\\s*\\(EURO\\)", USD: "KASA\\s*\\(DOLAR\\)", GBP: "KASA\\s*\\(STERLİN\\)" },
  receipt_text: { counterparty: "Günlük toplam", description: "Klinik günlük toplam tahsilat" },
};

/**
 * Float terms in evaluation order. Legacy summed the columns in ascending column order
 * (FI:57: 2, 4×EUR, 5×USD, 6×GBP, 7, 8; FI:60: 13×EUR, 14×USD, 15×GBP, 16, 17, 18), so the
 * terms are ordered by column, which keeps the float results byte-identical (C11).
 */
export function layoutTerms(part: { try_cols: number[]; eur_cols: number[]; usd_cols: number[]; gbp_cols: number[] }): Term[] {
  const terms: Term[] = [
    ...part.try_cols.map((col) => ({ col })),
    ...part.eur_cols.map((col) => ({ col, fx: "EUR" as const })),
    ...part.usd_cols.map((col) => ({ col, fx: "USD" as const })),
    ...part.gbp_cols.map((col) => ({ col, fx: "GBP" as const })),
  ];
  return terms.sort((a, b) => a.col - b.col);
}

/** Contiguous activity range of a part (BI:14: slice(2,9) and slice(13,19) for the template). */
export function activityRange(terms: Term[]): [number, number] {
  const cols = terms.map((t) => t.col);
  return [Math.min(...cols), Math.max(...cols) + 1];
}

export type LayoutValidation = { ok: true; layout: WorkbookLayout } | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Mirrors fin__layout_config exactly (unknown keys, wrong types, columns outside 0..255, first_row 0..10000,
 * arrays > 10, sheet names 1..100, patterns 1..200 except the skip patterns 0..200, cash: TRY required,
 * receipt description 1..900) plus what only the browser can check: patterns compile and are backtracking-safe.
 */
export function validateWorkbookLayout(config: unknown): LayoutValidation {
  const errors: string[] = [];
  const keys = (o: Record<string, unknown>, allowed: string[], at: string) => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) errors.push(`${at}${k}: bilinmeyen alan.`);
    for (const k of allowed) if (!(k in o)) errors.push(`${at}${k}: eksik.`);
  };
  const col = (v: unknown, at: string) => {
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 255) errors.push(`${at}: 0-255 arası sütun numarası olmalı.`);
  };
  const cols = (v: unknown, at: string, min = 0) => {
    if (!Array.isArray(v) || v.length < min || v.length > 10) {
      errors.push(`${at}: en fazla 10 sütun listesi olmalı.`);
      return;
    }
    v.forEach((c, i) => col(c, `${at}[${i}]`));
  };
  const text = (v: unknown, at: string, max = 200, min = 1) => {
    if (typeof v !== "string" || (min > 0 && !v.trim()) || v.length < min || v.length > max)
      errors.push(`${at}: ${min}-${max} karakter olmalı.`);
  };
  const pattern = (v: unknown, at: string, flags: string, min = 1) => {
    text(v, at, 200, min);
    if (typeof v === "string" && v)
      try {
        new RegExp(v, flags);
        const unsafe = regexSafetyProblem(v);
        if (unsafe) errors.push(`${at}: ${unsafe}`);
      } catch {
        errors.push(`${at}: geçersiz desen.`);
      }
  };
  if (!isObj(config)) return { ok: false, errors: ["Düzen bir nesne olmalı."] };
  keys(
    config,
    ["version", "required_sheets", "day_sheet_pattern", "fx_sheet", "fx_code_col", "fx_rate_col", "first_row", "receipt", "expense", "cash", "receipt_text"],
    "",
  );
  if (config.version !== 1) errors.push("version: 1 olmalı.");
  if (!Array.isArray(config.required_sheets) || !config.required_sheets.length || config.required_sheets.length > 10)
    errors.push("required_sheets: 1-10 sayfa adı olmalı.");
  else config.required_sheets.forEach((s, i) => text(s, `required_sheets[${i}]`, 100));
  pattern(config.day_sheet_pattern, "day_sheet_pattern", "");
  text(config.fx_sheet, "fx_sheet", 100);
  col(config.fx_code_col, "fx_code_col");
  col(config.fx_rate_col, "fx_rate_col");
  if (!Number.isInteger(config.first_row) || (config.first_row as number) < 0 || (config.first_row as number) > 10000)
    errors.push("first_row: 0-10000 arası satır numarası olmalı.");
  const r = config.receipt;
  if (!isObj(r)) errors.push("receipt: nesne olmalı.");
  else {
    keys(r, ["row_no_col", "name_col", "skip_name_pattern", "try_cols", "eur_cols", "usd_cols", "gbp_cols"], "receipt.");
    col(r.row_no_col, "receipt.row_no_col");
    col(r.name_col, "receipt.name_col");
    pattern(r.skip_name_pattern, "receipt.skip_name_pattern", "i", 0);
    cols(r.try_cols, "receipt.try_cols", 1);
    cols(r.eur_cols, "receipt.eur_cols");
    cols(r.usd_cols, "receipt.usd_cols");
    cols(r.gbp_cols, "receipt.gbp_cols");
  }
  const e = config.expense;
  if (!isObj(e)) errors.push("expense: nesne olmalı.");
  else {
    keys(e, ["desc_col", "total_col", "skip_desc_pattern", "try_cols", "eur_cols", "usd_cols", "gbp_cols", "bank_cols"], "expense.");
    col(e.desc_col, "expense.desc_col");
    col(e.total_col, "expense.total_col");
    pattern(e.skip_desc_pattern, "expense.skip_desc_pattern", "i", 0);
    cols(e.try_cols, "expense.try_cols", 1);
    cols(e.eur_cols, "expense.eur_cols");
    cols(e.usd_cols, "expense.usd_cols");
    cols(e.gbp_cols, "expense.gbp_cols");
    cols(e.bank_cols, "expense.bank_cols");
  }
  const c = config.cash;
  if (!isObj(c)) errors.push("cash: nesne olmalı.");
  else {
    for (const k of Object.keys(c)) if (!["TRY", "EUR", "USD", "GBP"].includes(k)) errors.push(`cash.${k}: bilinmeyen alan.`);
    if (!("TRY" in c)) errors.push("cash.TRY: eksik.");
    for (const k of ["TRY", "EUR", "USD", "GBP"]) if (k in c) pattern(c[k], `cash.${k}`, "i");
  }
  const t = config.receipt_text;
  if (!isObj(t)) errors.push("receipt_text: nesne olmalı.");
  else {
    keys(t, ["counterparty", "description"], "receipt_text.");
    text(t.counterparty, "receipt_text.counterparty");
    text(t.description, "receipt_text.description", 900);
  }
  if (!errors.length) {
    const layout = config as unknown as WorkbookLayout;
    for (const [name, part] of [
      ["receipt", layout.receipt],
      ["expense", layout.expense],
    ] as const) {
      const all = layoutTerms(part).map((x) => x.col);
      if (new Set(all).size !== all.length) errors.push(`${name}: aynı sütun birden çok tutar alanında.`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, layout: config as unknown as WorkbookLayout };
}
