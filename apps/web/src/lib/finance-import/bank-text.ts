// Finance import, parser B: known-bank text PDFs (Garanti, TEB, VakıfBank)
// (spec p2i_parsers_rules §5; legacy FI:23-44). Ported verbatim except bank detection (D5),
// which uses format markers in the statement's header/footer zone instead of a clinic branch label.

import { classify, suggestEntitlementMonth, type CompiledRules } from "./classify";
import { knownBankKey, legacySubcategory } from "./keys";
import { trNumber, isoDate } from "./primitives";
import { ImportParseError, warning, type ParseResult, type ParsedRow, type PdfCell, type RowKind, type SourceKind } from "./types";

export type KnownBank = "Garanti" | "TEB" | "VakıfBank";

/** Format markers (bank names are format knowledge; spelled exactly as they appear in keys). */
export const BANK_MARKERS: readonly [KnownBank, RegExp][] = [
  ["Garanti", /garantibbva|T. Garanti Bankası/i],
  ["TEB", /TÜRK EKONOMİ|Türk Ekonomi Bankası|teb\.com\.tr/],
  ["VakıfBank", /vakifbank|Vakiflar Bankası/i],
];

export const TEB_MARKER = BANK_MARKERS[1][1];

/** §5.1 (FI:27): re-join split decimals and collapse spaces/tabs (newlines kept). */
export const normalizeBankText = (text: string): string =>
  text
    .replace(/\r/g, "")
    .replace(/(\d)\s*\n\s*(,\d{2})/g, "$1$2")
    .replace(/[ \t]+/g, " ");

/**
 * §5.2: if exactly one bank's marker matches in the first 15 / last 10 non-empty lines, that bank;
 * otherwise the legacy order over `whole` (defaults to the text itself). '' when nothing matches.
 */
export function detectBank(text: string, whole: string = text): KnownBank | "" {
  const lines = text
    .split("\n")
    .map((v) => v.trim())
    .filter(Boolean);
  const zone = (lines.length > 25 ? [...lines.slice(0, 15), ...lines.slice(-10)] : lines).join("\n");
  const inZone = BANK_MARKERS.filter(([, re]) => re.test(zone));
  if (inZone.length === 1) return inZone[0][0];
  for (const [bank, re] of BANK_MARKERS) if (re.test(whole)) return bank;
  return "";
}

/** §3.2 step 2: a page with fewer than 50 characters of text has no readable text. */
export const pageHasText = (cells: PdfCell[]): boolean => cells.map((c) => c.str).join("").trim().length >= 50;

/** IP:36: one '\n' after every item, one more per page. */
export const pdfPagesText = (pages: PdfCell[][]): string =>
  pages.map((cells) => cells.map((item) => item.str + "\n").join("") + "\n").join("");

export const SCANNED_PDF_NOTICE =
  "Bu PDF’de okunabilir metin yok (taranmış veya görsel PDF). Metin tanıma ile çıkardığınız tabloyu aşağıdan yapıştırabilir veya bankanın Excel/CSV dosyasını yükleyebilirsiniz.";

export type BankRowInput = {
  file: string;
  /** '<Bank>:<account>' (known readers) or the mapper key label. */
  bankAccount: string;
  date: string;
  description: string;
  /** Signed JS float in TL; formatted into the key with Number::toString. */
  amountTl: number;
  /** Raw balance text as it appears in the key. */
  balance: string;
  reference?: string;
  sourceKind: SourceKind;
  kind?: RowKind;
  rules: CompiledRules;
};

/** FI:23-25 bankRow plus the DentOS classification and the C8 inflow rule. */
export function bankRow(input: BankRowInput): ParsedRow {
  const { amountTl } = input;
  const amount = Math.round(Math.abs(amountTl) * 100);
  const signedCents = amountTl > 0 ? amount : -amount;
  const cls = classify(input.rules, input.description, amountTl, "bank");
  const warnings = cls ? (cls.warning ? [cls.warning] : []) : [warning("W_CHECK")];
  // 0038: the month a hakediş-month rule suggests (its own text, the person's name, is not read as a month); a row
  // that gets one arrives selected (outflows, C8).
  const ruleMonth = cls?.requiresEntitlementMonth
    ? suggestEntitlementMonth(cls.entitlementMonthDefault, input.description, input.date, cls.pattern)
    : null;
  return {
    key: knownBankKey(input.bankAccount, input.date, amountTl, input.balance, input.reference ?? ""),
    kind: input.kind ?? (amountTl > 0 ? "bank_in" : "bank_out"),
    sourceKind: input.sourceKind,
    file: input.file.slice(0, 200),
    date: input.date,
    description: input.description.trim().slice(0, 900),
    amount,
    signedCents,
    bucket: cls?.bucket ?? null,
    categoryId: cls?.categoryId ?? null,
    subcategory: legacySubcategory(cls?.bucket ?? null, input.description),
    // A configured counterparty is used only for entitlement rows (IP:54); every other row keeps its narration.
    counterpartyId: cls?.requiresEntitlementMonth ? cls.counterpartyId : null,
    requiresEntitlementMonth: !!cls?.requiresEntitlementMonth,
    ruleId: cls?.ruleId ?? null,
    legacyAccount: "Banka",
    accountImportKey: input.bankAccount,
    // C8: bank inflows never start selected, whatever the rule says.
    selected: amountTl < 0 && (!!cls?.autoSelect || ruleMonth !== null),
    warnings,
    entitlementMonth: ruleMonth,
    ...(ruleMonth ? { ruleEntitlementMonth: ruleMonth } : {}),
    meta: {},
  };
}

export const NO_ROWS_ERROR =
  "PDF’de işlem satırı okunamadı. Taranmış görseller desteklenmiyor; bankanın metin içeren PDF dökümünü yükleyin.";
export const UNKNOWN_BANK_ERROR = "Bu PDF banka biçimi tanınmadı. Garanti, TEB veya VakıfBank hesap hareketlerini kullanın.";

export type BankTextResult = ParseResult & { bank: KnownBank; account: string; accountImportKey: string };

const MONEY_LINE = /^[+-]?\s*\d[\d.]*,\d{2}(?:\s*TL)?(?:\s+.*)?$/;
const MONEY = /[+-]?\s*\d[\d.]*,\d{2}/;

/** FI:26-44 parseBankText. Throws ImportParseError (legacy texts) when the bank or rows are not found. */
export function parseBankText(text: string, file: string, rules: CompiledRules): BankTextResult {
  const t = normalizeBankText(text);
  const rows: ParsedRow[] = [];
  const bank = detectBank(t);
  if (!bank) throw new ImportParseError(UNKNOWN_BANK_ERROR);
  const account = (t.match(/(?:Hesap Numarası|Hesap No:)\s*:?\s*([\d -]+)/)?.[1] || bank).trim().replace(/\s/g, "");
  const bankAccount = bank + ":" + account;
  const lines = t
    .split("\n")
    .map((v) => v.trim())
    .filter(Boolean);
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++)
    if (
      /^\d{2}\.\d{2}\.\d{4}$/.test(lines[i]) &&
      (bank !== "TEB" || (/^\d{2}\.\d{2}\.\d{4}$/.test(lines[i + 1] || "") && /^\d{2}:\d{2}/.test(lines[i + 2] || "")))
    )
      starts.push(i);
  for (let k = 0; k < starts.length; k++) {
    const block = lines.slice(starts[k] + 1, starts[k + 1] ?? lines.length);
    const date = isoDate(lines[starts[k]]);
    const moneyIndexes = block.map((v, i) => (MONEY_LINE.test(v) ? i : -1)).filter((i) => i >= 0);
    if (moneyIndexes.length < 2) continue;
    const a = moneyIndexes[0];
    const b = moneyIndexes[1];
    const amt = (block[a].match(MONEY) as RegExpMatchArray)[0];
    const bal = (block[b].match(MONEY) as RegExpMatchArray)[0];
    let desc = bank === "VakıfBank" ? block.slice(b).join(" ").replace(bal, "") : block.slice(bank === "TEB" ? 2 : 0, a).join(" ");
    if (bank === "VakıfBank") desc = desc.split("***Dekont")[0];
    const amountTl = trNumber(amt);
    rows.push({
      ...bankRow({ file, bankAccount, date, description: desc, amountTl, balance: bal, sourceKind: "bank_known", rules }),
      meta: { line: starts[k] + 1 },
    });
    const fee = bank === "Garanti" && amountTl > 0 ? desc.match(/K:\s*([\d.]+,\d{2})/) : null;
    if (fee)
      rows.push({
        ...bankRow({
          file,
          bankAccount,
          date,
          description: "POS komisyonu (net yatıştan kesilmiş): " + desc,
          amountTl: -trNumber(fee[1]),
          balance: bal,
          reference: "fee",
          sourceKind: "bank_known",
          kind: "bank_fee_split",
          rules,
        }),
        meta: { line: starts[k] + 1 },
      });
  }
  if (!rows.length) throw new ImportParseError(NO_ROWS_ERROR);
  return {
    bank,
    account,
    accountImportKey: bankAccount,
    rows,
    issues: [],
    notes: [
      `${file}: ${rows.length} banka hareketi okundu. Banka girişleri çift tahsilatı önlemek için seçili değil. Tarih ve tutarları önizlemede kontrol edin.`,
    ],
  };
}
