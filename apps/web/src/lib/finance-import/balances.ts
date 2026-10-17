// Finance import: balances read from files (spec p2i_parsers_rules §13; legacy BI:3-26, IP:50).
// Sources feed fin_import_balances (p2i_db_contract §4.9), which wraps the Phase 1 merge
// (fin_merge_balance_sources) that enforces every merge rule (C17). Nothing here writes data.

import type { TableClosing } from "./bank-table";
import { detectBank, normalizeBankText } from "./bank-text";
import { activityRange, layoutTerms, type WorkbookLayout } from "./layout";
import { isoDate, optionalPattern, trNumber } from "./primitives";
import { daySheets } from "./workbook";
import type { BalanceSource, SheetBook } from "./types";

/** D15: account shown masked to its last 4 characters (the key keeps the full string). */
export const maskedLabel = (bank: string, account: string): string =>
  bank + " · " + (account.length > 4 ? "…" + account.slice(-4) : account);

/**
 * D15 for an account import key: '<Bank>:<account number>' as the ready readers label it; any other (mapper) key keeps
 * its words, and every run of 6+ digits (spaces / dashes inside allowed) is shown by its last 4 digits.
 */
export function maskedKeyLabel(key: string): string {
  const i = key.indexOf(":");
  if (i > 0 && /^\d[\d-]*$/.test(key.slice(i + 1))) return maskedLabel(key.slice(0, i), key.slice(i + 1));
  return key.replace(/\d[\d -]*\d/g, (run) => {
    const digits = run.replace(/\D/g, "");
    return digits.length >= 6 ? "…" + digits.slice(-4) : run;
  });
}

export const BANK_BALANCE_NOTE = "Dökümdeki hesap bakiyesi; kullanılabilir limit veya işlem toplamı değildir.";
export const TABLE_BALANCE_NOTE =
  "Dökümdeki son işlemden sonraki hesap bakiyesi; kullanılabilir limit veya işlem toplamı değildir.";
export const TABLE_BALANCE_UNKNOWN = "Bakiye sütunu okundu ama son bakiye belirlenemedi; Bakiyeler ekranından elle girin.";

export type TableBalanceResult = { source: BalanceSource | null; note: string | null };

/**
 * Column-mapped statement (bank-table.ts): the balance after its last movement, offered for the resolved account's
 * import key. No source and no note when no balance column is mapped, nothing was read or no account is resolved;
 * TABLE_BALANCE_UNKNOWN when the last balance cannot be told or its day is after `today` (the merge refuses it).
 */
export function tableBalance(
  closing: TableClosing | null,
  opts: { importKey: string; file: string; today: string }
): TableBalanceResult {
  const importKey = opts.importKey.trim();
  if (!closing || !importKey) return { source: null, note: null };
  if (!closing.ok || closing.day > opts.today || closing.day < "2000-01-01" || !Number.isSafeInteger(closing.amountCents))
    return { source: null, note: TABLE_BALANCE_UNKNOWN };
  return {
    source: {
      kind: "bank",
      importKey,
      label: maskedKeyLabel(importKey),
      day: closing.day,
      amountCents: closing.amountCents,
      file: opts.file,
      note: TABLE_BALANCE_NOTE,
    },
    note: null,
  };
}

/** fin_set_account_import_key's key form ('Banka:hesap'). */
export const IMPORT_KEY_FORM = /^[^:\s][^:]*:[^:]+$/;
export const TABLE_BALANCE_NEEDS_KEY =
  "Bakiye okundu; kaydetmek için bu hesaba “Banka:hesap” biçiminde, başka hesapta kullanılmayan bir içe aktarma anahtarı verin (Banka + hesap etiketi).";

type KeyedAccount = { id: string; import_key: string | null };

/**
 * The column mapper's balance for the account chosen there: under the account's import key; for an account without
 * one, under the mapper key only when the balances card can link it (fin_set_account_import_key takes an unused
 * 'Banka:hesap' key; another account's key would put the balance on that account), else TABLE_BALANCE_NEEDS_KEY.
 */
export function mapperBalance(
  closing: TableClosing | null,
  opts: { account: KeyedAccount; keyLabel: string; accounts: readonly KeyedAccount[]; file: string; today: string }
): TableBalanceResult {
  const own = opts.account.import_key?.trim();
  const importKey = own || opts.keyLabel.trim();
  const read = tableBalance(closing, { importKey, file: opts.file, today: opts.today });
  if (!read.source || own) return read;
  const linkable = IMPORT_KEY_FORM.test(importKey) && !opts.accounts.some((a) => a.id !== opts.account.id && a.import_key === importKey);
  return linkable ? { source: { ...read.source, accountId: opts.account.id }, note: null } : { source: null, note: TABLE_BALANCE_NEEDS_KEY };
}

/** §13.1 (BI:3-11) PDF header balance. Returns null when bank, account, value or period is missing. */
export function bankBalance(text: string, file: string): BalanceSource | null {
  const t = text.replace(/(\d)\s*\n\s*(,\d{2})/g, "$1$2").replace(/\s+/g, " ");
  const bank = detectBank(normalizeBankText(text), t);
  const account = t.match(/(?:Hesap Numarası|Hesap No:)\s*:?\s*([\d -]+)/)?.[1]?.replace(/\s/g, "");
  const value = t.match(/\bBakiye\s*:?\s*(-?[\d.]+,\d{2})\s*TL/i)?.[1];
  const dates = Array.from(t.matchAll(/(\d{2}[./]\d{2}[./]\d{4})\s*-\s*(\d{2}[./]\d{2}[./]\d{4})/g))
    .map((m) => isoDate(m[2]))
    .sort();
  if (!bank || !account || value === undefined || !dates.length) return null;
  return {
    kind: "bank",
    importKey: bank + ":" + account,
    label: maskedLabel(bank, account),
    day: dates[dates.length - 1],
    amountCents: Math.round(trNumber(value) * 100),
    file,
    note: BANK_BALANCE_NOTE,
  };
}

export const CASH_INVALID = "Kasa bakiyesi eksik veya geçersiz; Excel’i hesaplatıp kaydedin.";
export const CASH_FX_MISSING = "Kasa dövizi için kur eksik.";

const CASH_CODES = [
  ["TRY", "TL"],
  ["EUR", "EUR"],
  ["USD", "USD"],
  ["GBP", "GBP"],
] as const;

export type CashBalanceResult = { source: BalanceSource | null; error: string | null; activeDays: string[] };

/** §13.4 (BI:12-20) workbook cash on the last day sheet that has real activity. */
export function workbookCashBalance(book: SheetBook, layout: WorkbookLayout, month: string, file: string): CashBalanceResult {
  const noCol = layout.receipt.row_no_col;
  const nameCol = layout.receipt.name_col;
  const descCol = layout.expense.desc_col;
  const [r0, r1] = activityRange(layoutTerms(layout.receipt));
  const [e0, e1] = activityRange(layoutTerms(layout.expense));
  const skipName = optionalPattern(layout.receipt.skip_name_pattern, "i");
  const skipDesc = optionalPattern(layout.expense.skip_desc_pattern, "i");
  const nonZero = (v: unknown) => typeof v === "number" && v !== 0;
  const active = (r: unknown[]) =>
    typeof r[noCol] === "number" &&
    ((typeof r[nameCol] === "string" && !skipName.test(r[nameCol] as string) && r.slice(r0, r1).some(nonZero)) ||
      (typeof r[descCol] === "string" && !skipDesc.test(r[descCol] as string) && r.slice(e0, e1).some(nonZero)));
  const days = daySheets(book, layout, month)
    .map(([name]) => name)
    .filter((name) => book.sheets[name].some((r) => Array.isArray(r) && active(r)))
    .sort();
  const day = days[days.length - 1];
  if (!day) return { source: null, error: null, activeDays: days };
  const t = book.sheets[day];
  // TRY is required; a currency the layout has no label for is not on the sheet (p2i_db_contract §2.7).
  const labels = CASH_CODES.map(([code]) => {
    const p = layout.cash[code];
    return p ? new RegExp(p, "i") : null;
  });
  const tryLabel = labels[0] as RegExp;
  const header = t.findIndex((r) => r.some((v) => typeof v === "string" && tryLabel.test(v)));
  if (header < 0) return { source: null, error: null, activeDays: days };
  const rates = Object.prototype.hasOwnProperty.call(book.sheets, layout.fx_sheet) ? book.sheets[layout.fx_sheet] : null;
  const parts: { code: string; amount: number; rate: number }[] = [];
  for (let i = 0; i < CASH_CODES.length; i++) {
    const [code, label] = CASH_CODES[i];
    const re = labels[i];
    if (!re) continue;
    const col = t[header].findIndex((v) => typeof v === "string" && re.test(v));
    const amount = col >= 0 ? t[header + 1]?.[col] : undefined;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return { source: null, error: CASH_INVALID, activeDays: days };
    const rate = code === "TRY" ? 1 : rates?.find((r) => r[layout.fx_code_col] === code)?.[layout.fx_rate_col];
    if (amount && (typeof rate !== "number" || !(rate > 0))) return { source: null, error: CASH_FX_MISSING, activeDays: days };
    parts.push({ code: label, amount, rate: typeof rate === "number" ? rate : 0 });
  }
  return {
    source: {
      kind: "cash",
      importKey: "clinic-cash",
      label: "Klinik nakit kasa",
      day: month + "-" + day,
      // Rounded once, terms in order TL, EUR, USD, GBP (C11).
      amountCents: Math.round(parts.reduce((n, p) => n + p.amount * p.rate, 0) * 100),
      file,
      note:
        parts.map((p) => `${p.amount} ${p.code}${p.amount && p.code !== "TL" ? " × " + p.rate : ""}`).join(" + ") +
        ". Dosyada kaydedilmiş gün sonu kasa değerleri; döviz kuru dosyadan alınır.",
    },
    error: null,
    activeDays: days,
  };
}

/** §3.5 (IP:50): merge session sources by key; a later or equal day replaces an earlier one. */
export function mergeSessionBalances(previous: BalanceSource[], next: BalanceSource[]): BalanceSource[] {
  const merged = new Map(previous.map((b) => [b.importKey, b]));
  for (const b of next) {
    const prior = merged.get(b.importKey);
    if (!prior || b.day >= prior.day) merged.set(b.importKey, b);
  }
  return Array.from(merged.values());
}

/** fin_import_balances item (p2i_db_contract §4.9 step 3, strict keys). */
export const toBalancePayload = (s: BalanceSource) => ({
  kind: s.kind,
  import_key: s.importKey,
  amount_cents: s.amountCents,
  as_of: s.day,
  label: s.label,
  file_name: s.file.slice(0, 200),
  note: s.note,
});
