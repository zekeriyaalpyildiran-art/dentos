// Finance import: shared types and warning texts (spec p2i_parsers_rules §2, §10.5, §13).

import type { ReportBucket, Subcategory } from "../finance";

export type { ReportBucket, Subcategory };

/** A spreadsheet as read by SheetJS: sheet names in book order plus `header:1` row arrays. */
export type SheetBook = { names: string[]; sheets: Record<string, unknown[][]> };

/** A pdf.js text item as legacy used it (`'str' in item`). */
export type PdfCell = { str: string; transform: number[]; width: number };

export type RowKind =
  | "workbook_receipts" // clinic:<day>:receipts
  | "workbook_expense" // clinic:<day>:expense:<n>
  | "bank_in"
  | "bank_out"
  | "bank_fee_split"; // Garanti POS commission split off a net inflow (reference 'fee')

/** fin_import_sources.source_kind of a row (p2i_db_contract §2.5, §4.7 `kind`). */
export type SourceKind = "clinic_excel" | "bank_known" | "bank_table";

/** Legacy account role word; decides the account rule and the fingerprint (§2.2). */
export type LegacyAccount = "Banka" | "Nakit" | "Karma";

export type WarningCode =
  | "W_BANK_IN"
  | "W_OFFICIAL_FEE"
  | "W_TRANSFER"
  | "W_PHYSICIAN"
  | "W_LOAN"
  | "W_CHECK"
  | "W_FX_EXCHANGE"
  | "W_ENTITLEMENT_MONTH"
  | "W_FX_RATE"
  | "W_TABLE_ROW" // generic-mapper prefix text (BT:50)
  | "W_RULE"; // an owner rule's own warning text

export type RowWarning = { code: WarningCode; text: string };

/** §10.5 legacy texts. Rule rows carry their own text; these are matched back to a code. */
export const WARNING_TEXT: Record<Exclude<WarningCode, "W_TABLE_ROW" | "W_RULE">, string> = {
  W_BANK_IN: "Banka girişi: klinik Excel’indeki tahsilatı tekrar saymayın. POS / virman girişleri seçili değildir.",
  W_OFFICIAL_FEE: "Resmi harç: vergi/SGK yerine diğer faaliyet giderinde izlenir.",
  W_TRANSFER: "Hesaplar arası transfer; gider değildir.",
  W_PHYSICIAN: "Hekim ödemesi: hakediş dönemini ve tekrar kaydı kontrol edin.",
  W_LOAN: "Kredi / kart ödemesi: anapara, faiz ve harcama ayrımı gerekli.",
  W_CHECK: "Kategorisini kontrol edip seçin.",
  W_FX_EXCHANGE: "Döviz bozdurma; faaliyet gideri değildir.",
  W_ENTITLEMENT_MONTH:
    "Hakediş ayını belirleyin. Önceden kaydedilmiş hakedişin ödemesiyse mevcut kayda işleyin; yeniden gider eklemeyin.",
  W_FX_RATE: "Döviz, dosyadaki kurla TL’ye çevrildi; işlem gününün kurunu kontrol edin.",
};

export const warning = (code: Exclude<WarningCode, "W_TABLE_ROW" | "W_RULE">): RowWarning => ({
  code,
  text: WARNING_TEXT[code],
});

/** Maps a rule's warning text back to a known code (legacy texts), else W_RULE. */
export function warningFromText(text: string): RowWarning | null {
  const t = text.trim();
  if (!t) return null;
  for (const [code, known] of Object.entries(WARNING_TEXT)) if (known === t) return { code: code as WarningCode, text: t };
  return { code: "W_RULE", text: t };
}

/** Parser output row (§2.1). Review edits change date/description/amount/category in place; keys never change. */
export type ParsedRow = {
  /** source_key, byte-identical to legacy (§9). */
  key: string;
  kind: RowKind;
  sourceKind: SourceKind;
  /** File name, ≤ 200 chars. */
  file: string;
  /** 'YYYY-MM-DD'; also the payment date when saved. */
  date: string;
  /** ≤ 900 chars as parsed. */
  description: string;
  /** Integer cents, absolute value. */
  amount: number;
  /** + inflow / − outflow. */
  signedCents: number;
  /** Classification result; null = uncategorised (user must pick). */
  bucket: ReportBucket | null;
  /** Category id of the matched rule; null when the bucket's system category should be used. */
  categoryId: string | null;
  subcategory: Subcategory | null;
  /** Counterparty master proposed by the matched rule (e.g. a physician). */
  counterpartyId: string | null;
  /** Matched rule needs an entitlement month before saving (§10.5). */
  requiresEntitlementMonth: boolean;
  ruleId: string | null;
  legacyAccount: LegacyAccount;
  /** Bank rows: '<Bank>:<account>' or the mapper key label; resolves fin_accounts.import_key. */
  accountImportKey: string | null;
  /** Default selection (§10.4). */
  selected: boolean;
  warnings: RowWarning[];
  /** 'YYYY-MM', set in review for entitlement rows (Hekim hakedişi; from 0038 also Personel, the salary month). */
  entitlementMonth: string | null;
  /** 0038: the month the matched rule suggested ('YYYY-MM'); shown as "(kuraldan)" while entitlementMonth equals it. */
  ruleEntitlementMonth?: string;
  meta: {
    line?: number;
    sheet?: string;
    table?: string;
    fxApplied?: boolean;
    formulaCellEmpty?: boolean;
    occurrence?: number;
    contributingRows?: number;
  };
};

export type ParseIssue = { line: number; reason: string; sheet?: string };

export type ParseResult = { rows: ParsedRow[]; notes: string[]; issues: ParseIssue[] };

/** A balance read from a file (§13). Feeds fin_import_balances (p2i_db_contract §4.9). */
export type BalanceSource = {
  kind: "bank" | "cash";
  /** '<Bank>:<account>' for banks, 'clinic-cash' for the workbook cash. */
  importKey: string;
  /** Display label (account masked to its last 4 digits, D15). */
  label: string;
  day: string;
  amountCents: number;
  file: string;
  note: string;
  /** Column mapper only: the finance account chosen there, preselected when the key still has to be linked. */
  accountId?: string;
};

/** Error with a user-facing Turkish message (legacy texts). Never contains row text unless legacy did. */
export class ImportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportParseError";
  }
}
