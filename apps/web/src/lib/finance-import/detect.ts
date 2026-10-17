// Finance import: file intake and format detection (spec p2i_parsers_rules §3).
// Pure: takes what read-file.ts produced (sheets or PDF text items) and decides which parser
// claims the file. The first step that claims a file wins.

import { bankBalance, workbookCashBalance, type CashBalanceResult } from "./balances";
import { pdfTable, type BankTable } from "./bank-table";
import { pageHasText, parseBankText, pdfPagesText, SCANNED_PDF_NOTICE } from "./bank-text";
import { detectTebSheet, parseTebSheet } from "./bank-xlsx";
import type { CompiledRules } from "./classify";
import { FINANCING_FILE_REFUSED, hasFinancingMarker } from "./financing";
import type { WorkbookLayout } from "./layout";
import { isClinicWorkbook, parseWorkbook, workbookFxRates, type WorkbookFxRates } from "./workbook";
import type { BalanceSource, ParseResult, ParsedRow, PdfCell, SheetBook } from "./types";

/** A bank card (BM:6): generic tables plus an optional ready reading of a known format. */
export type BankCard = {
  file: string;
  tables: BankTable[];
  notice: string;
  knownRows?: ParsedRow[];
  knownNotes?: string[];
  knownIssues?: ParseResult["issues"];
  /** '<Bank>:<account>' of the known reading. */
  accountImportKey?: string;
};

export type SavedWorkbookLayout = { id: string; layout: WorkbookLayout };

export type SpreadsheetOutcome =
  | { kind: "financing_refused"; message: string }
  | {
      kind: "workbook";
      layoutId: string;
      result: ParseResult;
      cash: CashBalanceResult;
      notes: string[];
      /** The fx sheet's rates, offered for saving as clinic fx_rates (spec p5 §7); null when none. */
      rates: WorkbookFxRates | null;
    }
  | { kind: "bank"; card: BankCard; balance: BalanceSource | null; notes: string[] };

const SHEET_NOTICE = "Başlık satırı ve sütunlar otomatik önerildi. Doğru değilse aşağıdan değiştirebilirsiniz.";
const PDF_NOTICE = "PDF’den okunan sütunları ve satırları aşağıda kontrol edin.";
const noBalance = (file: string) => `${file}: bakiye bulunamadı; mevcut bakiye korunacak.`;
const noSheetBalance = (file: string) =>
  `${file}: hazır okuyucu bakiye bulamadı; bakiye sütununu eşleştirip onaylarsanız son işlemden sonraki bakiye önerilir.`;
const noPdfBalance = (file: string) => `${file}: hesap bakiyesi otomatik okunamadı; hareket eşleştirmesi bakiyeyi değiştirmez.`;

/**
 * §3.1 for .xlsx/.xls/.csv on the general import screen. `layouts` are the active clinic_workbook
 * layouts (default first). A workbook parse error is thrown (the file is listed as unreadable);
 * a known-bank reader error falls back to the generic mapper, as legacy did.
 */
export function intakeSpreadsheet(
  book: SheetBook,
  opts: { file: string; month: string; layouts: readonly SavedWorkbookLayout[]; rules: CompiledRules },
): SpreadsheetOutcome {
  const { file } = opts;
  if (hasFinancingMarker(book)) return { kind: "financing_refused", message: FINANCING_FILE_REFUSED };
  const saved = opts.layouts.find((l) => isClinicWorkbook(book, l.layout));
  if (saved) {
    const result = parseWorkbook(book, { file, month: opts.month, layout: saved.layout, rules: opts.rules });
    const cash = workbookCashBalance(book, saved.layout, opts.month, file);
    const notes = cash.error ? [`${file}: ${cash.error}`] : cash.source ? [] : [noBalance(file)];
    const rates = workbookFxRates(book, saved.layout, opts.month, cash.activeDays, file);
    return { kind: "workbook", layoutId: saved.id, result, cash, notes, rates };
  }
  const tables: BankTable[] = book.names.filter((n) => Object.prototype.hasOwnProperty.call(book.sheets, n)).map((name) => ({ name, rows: book.sheets[name] }));
  const card: BankCard = { file, tables, notice: SHEET_NOTICE };
  let balance: BalanceSource | null = null;
  const notes: string[] = [];
  try {
    for (const t of tables) {
      const layout = detectTebSheet(t.rows);
      if (!layout) continue;
      const teb = parseTebSheet(t.rows, layout, file, opts.rules);
      if (!teb.rows.length) continue;
      card.knownRows = teb.rows.map((r) => ({ ...r, meta: { ...r.meta, sheet: t.name } }));
      card.knownNotes = teb.notes;
      card.knownIssues = teb.issues;
      card.accountImportKey = teb.accountImportKey;
      balance = teb.balance;
      if (teb.balanceNote) notes.push(teb.balanceNote);
      break;
    }
  } catch {
    card.knownRows = undefined;
    card.knownNotes = undefined;
    card.knownIssues = undefined;
    card.accountImportKey = undefined;
    balance = null;
  }
  if (!card.knownRows) notes.push(noSheetBalance(file));
  return { kind: "bank", card, balance, notes };
}

export type PdfOutcome = { card: BankCard; balance: BalanceSource | null; notes: string[]; scanned: boolean };

/** §3.2 for .pdf: scanned check, known reader (no OCR, D1), generic table, header balance. */
export function intakePdf(pages: PdfCell[][], opts: { file: string; rules: CompiledRules }): PdfOutcome {
  const { file } = opts;
  const text = pdfPagesText(pages);
  const scanned = pages.some((p) => !pageHasText(p));
  const card: BankCard = { file, tables: [pdfTable(pages)], notice: scanned ? SCANNED_PDF_NOTICE : PDF_NOTICE };
  if (!scanned) {
    try {
      const known = parseBankText(text, file, opts.rules);
      card.knownRows = known.rows;
      card.knownNotes = known.notes;
      card.accountImportKey = known.accountImportKey;
    } catch {
      // Unknown format or no rows: the generic table remains (IP:37).
    }
  }
  const notes: string[] = [];
  let balance: BalanceSource | null = null;
  try {
    balance = bankBalance(text, file);
    if (!balance) notes.push(noPdfBalance(file));
  } catch {
    notes.push(`${file}: bakiye okunamadı; hareketler ayrı aktarılabilir.`);
  }
  return { card, balance, notes, scanned };
}
